'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppinglist-sync-'));
process.env.SHOPPINGLIST_DATA_DIR = DATA_DIR;
process.env.PORT = '3368';

const sync = require('../src/sync');
const db = require('../src/db');

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function tailscaleRunner(status) {
  return (command, args, callback) => callback(null, JSON.stringify(status));
}

const STATUS = {
  Self: { HostName: 'me', DNSName: 'self.example.test.', TailscaleIPs: ['IP-SELF'] },
  Peer: {
    '1': {
      HostName: 'offline-box',
      DNSName: 'peer-b.example.test.',
      Online: false,
      TailscaleIPs: ['IP-PEER-B'],
    },
    '2': {
      HostName: 'online-box',
      DNSName: 'peer-a.example.test.',
      Online: true,
      TailscaleIPs: ['IP-PEER-A'],
    },
    '3': {
      HostName: 'me',
      DNSName: 'self.example.test.',
      Online: true,
    },
  },
};

test('初期設定は同期元・未設定で、設定ファイルはワークスペース外に保存される', () => {
  const config = sync.readConfig();
  assert.strictEqual(config.role, 'source');
  assert.strictEqual(config.peer, '');
  assert.strictEqual(config.sync_time, '03:00');
  assert.strictEqual(sync.CONFIG_FILE, path.join(DATA_DIR, 'sync-config.json'));
});

test('設定の入力値を検証し、保存時にファイル権限を 0600 にする', async () => {
  await assert.rejects(
    sync.saveConfig({ role: 'bad', peer: '', sync_time: '03:00' }),
    /同期元/
  );
  await assert.rejects(
    sync.saveConfig({ role: 'source', peer: 'javascript:alert(1)', sync_time: '03:00' }),
    /URL が不正/
  );
  await assert.rejects(
    sync.saveConfig({ role: 'source', peer: '', sync_time: '99:99' }),
    /HH:MM/
  );

  await sync.saveConfig(
    {
      role: 'source',
      peer: 'https://peer-a.example.test:3368',
      peer_name: 'online-box',
      sync_time: '04:30',
      notify_peer: false,
    },
    { deps: { runner: tailscaleRunner(STATUS) } }
  );

  const config = sync.readConfig();
  assert.strictEqual(config.role, 'source');
  assert.strictEqual(config.peer, 'https://peer-a.example.test:3368');
  assert.strictEqual(config.sync_time, '04:30');
  assert.strictEqual(fs.statSync(sync.CONFIG_FILE).mode & 0o777, 0o600);
});

test('Tailnet のピア一覧は稼働中を先頭にし、自分自身を除外する', async () => {
  const peers = await sync.getPeerList({ runner: tailscaleRunner(STATUS), env: { PORT: '3368' } });
  assert.deepStrictEqual(
    peers.map((p) => [p.name, p.online, p.url]),
    [
      ['online-box', true, 'https://peer-a.example.test:3368'],
      ['offline-box', false, 'https://peer-b.example.test:3368'],
    ]
  );

  const self = await sync.getSelfInfo({ runner: tailscaleRunner(STATUS), env: { PORT: '3368' } });
  assert.strictEqual(self.url, 'https://self.example.test:3368');
  assert.strictEqual(self.name, 'me');

  const failed = await sync.getPeerList({
    runner: (command, args, callback) => callback(new Error('not found')),
  });
  assert.deepStrictEqual(failed, []);
});

test('同期バンドルは購入履歴・購入店をミラーする', () => {
  db.addPurchase({ date: '2026-01-01', name: '同期A', memo: '', store: 'Amazon', price: 100, url: '' });
  db.addPurchase({ date: '2026-01-02', name: '同期B', memo: '', store: '楽天', price: 200, url: '' });
  const bundle = sync.buildBundle();
  assert.strictEqual(bundle.version, 1);
  assert.ok(bundle.exported_at);
  assert.ok(bundle.data.purchases.length >= 2);
  assert.ok(Array.isArray(bundle.data.stores));

  db.addPurchase({ date: '2026-01-03', name: '同期後ろ', memo: '', store: '', price: 300, url: '' });
  sync.applyBundle(bundle);
  const names = db.listPurchases().map((p) => p.name);
  assert.ok(names.includes('同期A'));
  assert.ok(names.includes('同期B'));
  assert.ok(!names.includes('同期後ろ'), '同期元に無い記録は削除されるべき');

  assert.throws(() => sync.applyBundle({ data: {} }), /不正な同期データ/);
});

test('同期元は相手へ import を POST し、同期先は export を取得して反映する', async () => {
  const calls = [];
  const requestJson = async (url, options) => {
    calls.push({ url, options });
    return {};
  };

  const pushed = await sync.runNow({ requestJson });
  assert.match(pushed.message, /送信しました/);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, 'https://peer-a.example.test:3368/api/sync/import');
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.ok(calls[0].options.body.data.purchases);

  await sync.saveConfig(
    {
      role: 'destination',
      peer: 'https://peer-a.example.test:3368',
      peer_name: 'online-box',
      sync_time: '04:30',
      notify_peer: false,
    },
    { deps: { requestJson } }
  );
  const bundle = sync.buildBundle();
  const pullCalls = [];
  const pullRequest = async (url, options) => {
    pullCalls.push(url);
    if (url.endsWith('/export')) return bundle;
    return {};
  };
  const pulled = await sync.runNow({ requestJson: pullRequest });
  assert.match(pulled.message, /取得しました/);
  assert.deepStrictEqual(pullCalls, ['https://peer-a.example.test:3368/api/sync/export']);
});

test('相手からの役割連動と停止連動が動作する', async () => {
  const role = sync.applyPeerRole({
    role: 'source',
    peer_url: 'https://self.example.test:3368',
    peer_name: 'me',
    sync_time: '05:00',
  });
  assert.strictEqual(role.role, 'source');
  assert.strictEqual(role.sync_time, '05:00');
  assert.strictEqual(sync.readConfig().last_sync, '', '時刻変更で当日フラグがリセットされる');

  const unlinked = sync.unlink({ peer_url: 'https://self.example.test:3368/' });
  assert.strictEqual(unlinked.unlinked, true);
  assert.strictEqual(sync.readConfig().peer, '');

  await sync.saveConfig(
    {
      role: 'source',
      peer: 'https://peer-a.example.test:3368',
      peer_name: 'online-box',
      sync_time: '04:30',
      notify_peer: false,
    },
    { deps: { requestJson: async () => ({}) } }
  );
  const stopped = await sync.stopSync({ notify_peer: false });
  assert.strictEqual(stopped.config.peer, '');
});

test('自動同期は指定時刻後・1日1回だけ実行される', async () => {
  await sync.saveConfig(
    {
      role: 'source',
      peer: 'https://peer-a.example.test:3368',
      peer_name: 'online-box',
      sync_time: '04:30',
      notify_peer: false,
    },
    { deps: { requestJson: async () => ({}) } }
  );
  const calls = [];
  const requestJson = async (url) => {
    calls.push(url);
    return {};
  };
  sync.writeConfig({ ...sync.readConfig(), last_sync: '' });

  const early = new Date(2026, 10, 18, 3, 0, 0);
  assert.strictEqual(await sync.schedulerTick(early, { requestJson }), false);
  assert.strictEqual(calls.length, 0);

  const late = new Date(2026, 10, 18, 5, 0, 0);
  assert.strictEqual(await sync.schedulerTick(late, { requestJson }), true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(
    await sync.schedulerTick(new Date(2026, 10, 18, 6, 0, 0), { requestJson }),
    false,
    '同じ日に2回は同期しない'
  );
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(
    await sync.schedulerTick(new Date(2026, 10, 19, 6, 0, 0), { requestJson }),
    true,
    '翌日は同期する'
  );
  assert.strictEqual(calls.length, 2);
});
