'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppinglist-test-'));
let PORT = 0;
let BASE = '';

process.env.SHOPPINGLIST_DATA_DIR = DATA_DIR;

let server;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function api(pathname, options = {}) {
  return fetch(`${BASE}${pathname}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

test.before(async () => {
  PORT = await findFreePort();
  BASE = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, [path.join(APP_ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch (e) {
      /* 起動待ち */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('サーバーが起動しませんでした');
});

test.after(async () => {
  if (server) server.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('初期状態の購入店には既定の4店が入る', async () => {
  const { body } = await api('/api/stores');
  const names = body.stores.map((s) => s.name);
  assert.deepStrictEqual(names, ['Amazon', '楽天', 'ヨドバシ', 'たのめーる']);
});

test('購入履歴を登録すると日付の新しい順に並ぶ', async () => {
  await api('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-01-01', name: '商品A', store: 'Amazon', price: 1000 }),
  });
  await api('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-03-01', name: '商品B', store: '楽天', price: 2000 }),
  });
  await api('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-02-01', name: '商品A', store: 'ヨドバシ', price: 3000 }),
  });

  const { body } = await api('/api/purchases');
  assert.deepStrictEqual(
    body.purchases.map((p) => p.date),
    ['2026-03-01', '2026-02-01', '2026-01-01']
  );
});

test('商品名ごとの最安値・平均・最高値を返す', async () => {
  const { body } = await api('/api/stats?name=' + encodeURIComponent('商品A'));
  assert.strictEqual(body.stats.count, 2);
  assert.strictEqual(body.stats.min, 1000);
  assert.strictEqual(body.stats.max, 3000);
  assert.strictEqual(body.stats.avg, 2000);
});

test('商品名を指定すると該当の履歴のみ返す', async () => {
  const { body } = await api('/api/state?name=' + encodeURIComponent('商品A'));
  assert.strictEqual(body.purchases.length, 2);
  assert.ok(body.purchases.every((p) => p.name === '商品A'));
  assert.strictEqual(body.stats.min, 1000);
});

test('購入店を追加できる', async () => {
  const { status, body } = await api('/api/stores', {
    method: 'POST',
    body: JSON.stringify({ name: '価格.com' }),
  });
  assert.strictEqual(status, 201);
  assert.ok(body.stores.some((s) => s.name === '価格.com'));
});

test('商品名が空の登録は拒否する', async () => {
  const { status } = await api('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-04-01', name: '  ', price: 100 }),
  });
  assert.strictEqual(status, 400);
});

test('不正なURLは拒否する', async () => {
  const { status } = await api('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({ date: '2026-04-01', name: '商品C', price: 100, url: 'javascript:alert(1)' }),
  });
  assert.strictEqual(status, 400);
});

test('メモを保存できる', async () => {
  const { status, body } = await api('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({
      date: '2026-05-01',
      name: '商品D',
      memo: '型番 A1234 / 黒',
      store: 'Amazon',
      price: 500,
    }),
  });
  assert.strictEqual(status, 201);
  assert.strictEqual(body.purchase.memo, '型番 A1234 / 黒');

  const list = await api('/api/purchases');
  const stored = list.body.purchases.find((p) => p.id === body.purchase.id);
  assert.strictEqual(stored.memo, '型番 A1234 / 黒');
});

test('商品名を編集できる', async () => {
  const list = await api('/api/purchases');
  const target = list.body.purchases.find((p) => p.name === '商品D');
  const { status, body } = await api(`/api/purchases/${target.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      date: target.date,
      name: '商品D改',
      memo: '型番 B5678 / 白',
      store: '楽天',
      price: 600,
      url: 'https://example.com/',
    }),
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.purchase.name, '商品D改');
  assert.strictEqual(body.purchase.memo, '型番 B5678 / 白');
  assert.strictEqual(body.purchase.store, '楽天');
  assert.strictEqual(body.purchase.price, 600);

  const after = await api('/api/purchases');
  const updated = after.body.purchases.find((p) => p.id === target.id);
  assert.strictEqual(updated.name, '商品D改');
  assert.strictEqual(updated.memo, '型番 B5678 / 白');
});

test('存在しないIDの更新はエラーになる', async () => {
  const { status } = await api('/api/purchases/999999', {
    method: 'PUT',
    body: JSON.stringify({ date: '2026-05-01', name: '商品E', price: 100 }),
  });
  assert.strictEqual(status, 404);
});

test('空の商品名への更新は拒否する', async () => {
  const list = await api('/api/purchases');
  const target = list.body.purchases[0];
  const { status } = await api(`/api/purchases/${target.id}`, {
    method: 'PUT',
    body: JSON.stringify({ date: target.date, name: '', price: 100 }),
  });
  assert.strictEqual(status, 400);
});

test('購入履歴を削除できる', async () => {
  const before = await api('/api/purchases');
  const target = before.body.purchases.find((p) => p.name === '商品B');
  const { status } = await api(`/api/purchases/${target.id}`, { method: 'DELETE' });
  assert.strictEqual(status, 200);
  const after = await api('/api/purchases');
  assert.ok(!after.body.purchases.some((p) => p.id === target.id));
});

test('JSON でエクスポートできる', async () => {
  const res = await fetch(`${BASE}/api/export?format=json`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename="shoppinglist-\d+\.json"/);
  const body = await res.json();
  assert.strictEqual(body.app, 'shoppinglist');
  assert.ok(Array.isArray(body.purchases));
  assert.ok(Array.isArray(body.stores));
  assert.ok(body.purchases.length > 0);
});

test('CSV でエクスポートできる (ヘッダーとBOM付き)', async () => {
  const res = await fetch(`${BASE}/api/export?format=csv`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/csv/);
  // fetch の text() は BOM を除去するためバイト列で確認する
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM がありません');
  const text = bytes.toString('utf8').replace('\uFEFF', '');
  const lines = text.split('\r\n');
  assert.strictEqual(lines[0], '日付,商品名,メモ,購入店,値段,URL');
  assert.ok(lines.length > 1);
});

test('インポート (マージ) で新規の記録を追加できる', async () => {
  const { body: before } = await api('/api/purchases');
  const { status, body } = await api('/api/import', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'merge',
      data: {
        purchases: [
          { id: 9001, date: '2026-06-01', name: 'インポート商品', memo: 'メモA', store: 'Amazon', price: 1000, url: '' },
        ],
        stores: [{ id: 9001, name: 'インポート店' }],
      },
    }),
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.inserted, 1);
  assert.strictEqual(body.updated, 0);

  const { body: after } = await api('/api/purchases');
  assert.strictEqual(after.purchases.length, before.purchases.length + 1);
  assert.ok(after.purchases.some((p) => p.name === 'インポート商品' && p.memo === 'メモA'));

  const { body: stores } = await api('/api/stores');
  assert.ok(stores.stores.some((s) => s.name === 'インポート店'));
});

test('インポート (マージ) で同じIDの記録は更新される', async () => {
  const { body } = await api('/api/import', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'merge',
      data: {
        purchases: [
          { id: 9001, date: '2026-06-02', name: 'インポート商品改', memo: 'メモB', store: '楽天', price: 2000, url: '' },
        ],
      },
    }),
  });
  assert.strictEqual(body.inserted, 0);
  assert.strictEqual(body.updated, 1);

  const { body: after } = await api('/api/purchases');
  const updated = after.purchases.find((p) => p.id === 9001);
  assert.strictEqual(updated.name, 'インポート商品改');
  assert.strictEqual(updated.price, 2000);
});

test('不正な行はスキップされる', async () => {
  const { body } = await api('/api/import', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'merge',
      data: {
        purchases: [
          { date: '2026-06-03', name: '', price: 100 },
          { date: 'not-a-date', name: '日付不正', price: 100 },
          { date: '2026-06-03', name: '価格不正', price: 'abc' },
          { date: '2026-06-03', name: '正常', price: 100 },
        ],
      },
    }),
  });
  assert.strictEqual(body.skipped, 3);
  assert.strictEqual(body.inserted, 1);
});

test('インポート (置き換え) で現在のデータを上書きできる', async () => {
  const { body } = await api('/api/import', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'replace',
      data: {
        purchases: [
          { id: 1, date: '2026-07-01', name: '置き換え商品', memo: 'メモC', store: 'ヨドバシ', price: 3000, url: '' },
        ],
        stores: [{ name: '置き換え店' }],
      },
    }),
  });
  assert.strictEqual(body.inserted, 1);

  const { body: after } = await api('/api/purchases');
  assert.strictEqual(after.purchases.length, 1);
  assert.strictEqual(after.purchases[0].name, '置き換え商品');

  const { body: stores } = await api('/api/stores');
  const names = stores.stores.map((s) => s.name);
  assert.ok(names.includes('置き換え店'));
  // 既定の購入店は残る
  for (const store of ['Amazon', '楽天', 'ヨドバシ', 'たのめーる']) {
    assert.ok(names.includes(store), `既定の購入店 ${store} がありません`);
  }
});

test('空のインポートはエラーになる', async () => {
  const { status } = await api('/api/import', {
    method: 'POST',
    body: JSON.stringify({ mode: 'merge', data: { purchases: [] } }),
  });
  assert.strictEqual(status, 400);
});

test('エクスポート→インポートでデータが復元できる', async () => {
  const exported = await (await fetch(`${BASE}/api/export?format=json`)).json();
  const { body } = await api('/api/import', {
    method: 'POST',
    body: JSON.stringify({ mode: 'replace', data: exported }),
  });
  assert.strictEqual(body.inserted, exported.purchases.length);

  const { body: after } = await api('/api/purchases');
  assert.strictEqual(after.purchases.length, exported.purchases.length);
});

test('通販検索の設定を保存するとワークスペース外のファイルに記録される', async () => {
  const { body: before } = await api('/api/settings');
  assert.strictEqual(before.easyparserKey.configured, false);
  assert.ok(before.storagePath.startsWith(DATA_DIR));

  const { status, body } = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      easyparserKey: 'API-KEY-ABCD1234',
      rakutenAppId: 'RAKUTEN-ID-5678',
      usdJpy: 150,
    }),
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(body.settings.easyparserKey.masked, '****1234');
  assert.ok(!JSON.stringify(body).includes('API-KEY-ABCD1234'));
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'search-config.json')));

  // 保存したキーが検索プロバイダの設定状況に反映される
  const { body: providers } = await api('/api/search/providers');
  assert.strictEqual(providers.configured.amazon, true);
  assert.strictEqual(providers.configured.rakuten, true);
});

test('通販検索の設定はマスクされた値だけが返り、削除もできる', async () => {
  const { body } = await api('/api/settings');
  assert.strictEqual(body.easyparserKey.configured, true);
  assert.ok(!JSON.stringify(body).includes('API-KEY-ABCD1234'));

  const { status } = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ easyparserKey: '' }),
  });
  assert.strictEqual(status, 200);
  const { body: after } = await api('/api/settings');
  assert.strictEqual(after.easyparserKey.configured, false);
  assert.strictEqual(after.rakutenAppId.configured, true);
});
