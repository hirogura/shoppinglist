'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const APP_ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppinglist-e2e-'));
const HTML = fs.readFileSync(path.join(APP_ROOT, 'public', 'index.html'), 'utf8');
const APP_JS = fs.readFileSync(path.join(APP_ROOT, 'public', 'js', 'app.js'), 'utf8');

let server;
let BASE = '';

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

// ブラウザ相当のDOMで app.js を実行し、入力→追加→編集→削除を通しで検証する
async function runInBrowser(fn) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push(e.message));

  const dom = new JSDOM(HTML, {
    url: `${BASE}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  window.fetch = (url, options) => fetch(new URL(url, BASE).toString(), options);
  window.confirm = () => true;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};

  // jsdom は <dialog> の showModal / close を実装していないため代用する
  if (!window.HTMLDialogElement.prototype.showModal) {
    window.HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    window.HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
  }

  window.eval(APP_JS);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 500));

  const result = await fn(window);
  return { result, errors };
}

function type(window, id, value) {
  const node = window.document.getElementById(id);
  node.value = value;
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function click(window, id) {
  window.document
    .getElementById(id)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  const port = await findFreePort();
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(APP_ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SHOPPINGLIST_DATA_DIR: DATA_DIR },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch (e) {
      /* 起動待ち */
    }
    await wait(100);
  }
  throw new Error('サーバーが起動しませんでした');
});

test.after(async () => {
  if (server) server.kill('SIGKILL');
  await wait(200);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('入力した商品名とメモが登録される', async () => {
  const { result, errors } = await runInBrowser(async (window) => {
    type(window, 'input-name', 'コーヒー');
    type(window, 'input-memo', 'ネスカフェ');
    type(window, 'input-price', '1234');
    type(window, 'input-url', 'https://example.com/');
    await wait(400);
    click(window, 'btn-add');
    await wait(1000);

    const doc = window.document;
    const toast = doc.getElementById('toast');
    const rows = [...doc.querySelectorAll('#history-body tr')].map((tr) =>
      [...tr.children].map((td) => td.textContent).join(' | ')
    );
    return { toast: toast.textContent, toastClass: toast.className, rows };
  });

  assert.deepStrictEqual(errors, [], 'フロントでエラーが発生しています');
  assert.ok(
    result.toast.includes('コーヒー'),
    `登録が完了していません (トースト: ${result.toast})`
  );
  assert.ok(!result.toastClass.includes('error'), `エラーが発生しています: ${result.toast}`);
  assert.ok(
    result.rows.some((row) => row.includes('コーヒー') && row.includes('ネスカフェ')),
    `一覧に商品名とメモが表示されていません: ${result.rows.join(' / ')}`
  );
});

test('履歴の編集で商品名を書き換えられる', async () => {
  const { result, errors } = await runInBrowser(async (window) => {
    const doc = window.document;
    const editButton = doc.querySelector('#history-body tr .btn-delete');
    editButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(300);

    type(window, 'input-name', 'コーヒー (改)');
    await wait(400);
    click(window, 'btn-add');
    await wait(1000);

    const { body } = await api('/api/purchases');
    return { purchases: body.purchases, toast: doc.getElementById('toast').textContent };
  });

  assert.deepStrictEqual(errors, [], 'フロントでエラーが発生しています');
  assert.ok(
    result.purchases.some((p) => p.name === 'コーヒー (改)' && p.memo === 'ネスカフェ'),
    `商品名が更新されていません: ${JSON.stringify(result.purchases)}`
  );
});

test('クリアで入力内容が消え一覧が全部に戻る', async () => {
  const { result, errors } = await runInBrowser(async (window) => {
    const doc = window.document;

    // 事前に2件登録しておく
    await api('/api/purchases', {
      method: 'POST',
      body: JSON.stringify({ date: '2026-08-01', name: 'クリア対象A', price: 100 }),
    });
    await api('/api/purchases', {
      method: 'POST',
      body: JSON.stringify({ date: '2026-08-02', name: 'クリア対象B', price: 200 }),
    });

    type(window, 'input-name', 'クリア対象A');
    type(window, 'input-memo', 'メモ');
    type(window, 'input-price', '100');
    type(window, 'input-url', 'https://example.com/');
    await wait(500);

    const filtered = doc.querySelectorAll('#history-body tr').length;

    click(window, 'btn-clear');
    await wait(800);

    const { body } = await api('/api/purchases');
    return {
      filtered,
      all: doc.querySelectorAll('#history-body tr').length,
      total: body.purchases.length,
      name: doc.getElementById('input-name').value,
      memo: doc.getElementById('input-memo').value,
      price: doc.getElementById('input-price').value,
      url: doc.getElementById('input-url').value,
      date: doc.getElementById('input-date').value,
      summaryHidden: doc.getElementById('summary-card').classList.contains('hidden'),
    };
  });

  assert.deepStrictEqual(errors, [], 'フロントでエラーが発生しています');
  assert.strictEqual(result.name, '', '商品名がクリアされていません');
  assert.strictEqual(result.memo, '', 'メモがクリアされていません');
  assert.strictEqual(result.price, '', '値段がクリアされていません');
  assert.strictEqual(result.url, '', 'URLがクリアされていません');
  assert.strictEqual(result.summaryHidden, true, '価格サマリーが消えていません');
  assert.strictEqual(result.filtered, 1, '絞り込みが効いていません');
  assert.strictEqual(result.all, result.total, '一覧が全件表示になっていません');
});

test('編集中にクリアすると編集が解除される', async () => {
  const { result, errors } = await runInBrowser(async (window) => {
    const doc = window.document;
    const editButton = doc.querySelector('#history-body tr .btn-delete');
    editButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(400);

    const editingBefore = !doc.getElementById('edit-banner').classList.contains('hidden');
    const labelBefore = doc.getElementById('btn-add').textContent;

    click(window, 'btn-clear');
    await wait(800);

    return {
      editingBefore,
      labelBefore,
      editingAfter: !doc.getElementById('edit-banner').classList.contains('hidden'),
      labelAfter: doc.getElementById('btn-add').textContent,
      name: doc.getElementById('input-name').value,
    };
  });

  assert.deepStrictEqual(errors, [], 'フロントでエラーが発生しています');
  assert.strictEqual(result.editingBefore, true, '編集モードになっていません');
  assert.strictEqual(result.labelBefore, '更新');
  assert.strictEqual(result.editingAfter, false, '編集モードが解除されていません');
  assert.strictEqual(result.labelAfter, '追加');
  assert.strictEqual(result.name, '');
});

test('エクスポートとインポートが動作する', async () => {
  const { result, errors } = await runInBrowser(async (window) => {
    const doc = window.document;

    // エクスポートダイアログが開く
    click(window, 'btn-export');
    await wait(200);
    const exportOpened = doc.getElementById('export-dialog').open;
    doc.getElementById('export-dialog').close();

    // エクスポートしたJSONをファイルとして読み込ませる (ファイル選択を再現)
    const exported = await (await fetch(`${BASE}/api/export?format=json`)).json();
    const file = new window.File([JSON.stringify(exported)], 'backup.json', {
      type: 'application/json',
    });
    const fileInput = doc.getElementById('import-file-input');
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(600);

    const importOpened = doc.getElementById('import-dialog').open;
    const count = doc.getElementById('import-count').textContent;

    click(window, 'btn-import-run');
    await wait(1200);

    const toast = doc.getElementById('toast');
    return {
      exportOpened,
      importOpened,
      count,
      expected: String(exported.purchases.length),
      toast: toast.textContent,
      toastClass: toast.className,
    };
  });

  assert.deepStrictEqual(errors, [], 'フロントでエラーが発生しています');
  assert.strictEqual(result.exportOpened, true, 'エクスポートダイアログが開きませんでした');
  assert.strictEqual(result.importOpened, true, 'インポート確認ダイアログが開きませんでした');
  assert.strictEqual(result.count, result.expected, '件数の表示が違います');
  assert.ok(result.toast.includes('インポートしました'), `インポートに失敗しました: ${result.toast}`);
  assert.ok(!result.toastClass.includes('error'), `エラーが発生しています: ${result.toast}`);
});

test('通販検索ペインで検索結果と購入履歴を同じ画面で確認し、履歴へ転記できる', async () => {
  const asin = 'B012345678';
  const productUrl = `https://www.amazon.co.jp/dp/${asin}/`;
  await api('/api/purchases', {
    method: 'POST',
    body: JSON.stringify({
      date: '2026-09-01',
      name: '検索対象商品',
      store: 'Amazon',
      price: 1000,
      url: productUrl,
    }),
  });

  const fakeSearch = {
    query: '検索対象商品',
    provider: 'all',
    credits: { remaining: 85, resetAt: '2026-12-01T00:00:00.000Z' },
    notices: [],
    externalLinks: [
      { id: 'amazon', label: 'Amazon', url: 'https://www.amazon.co.jp/s?k=x' },
      { id: 'rakuten', label: '楽天', url: 'https://search.rakuten.co.jp/search/mall/x/' },
      { id: 'yodobashi', label: 'ヨドバシ.com', url: 'https://www.yodobashi.com/?word=x' },
    ],
    items: [
      {
        id: `amazon:${asin}`,
        provider: 'amazon',
        providerLabel: 'Amazon',
        store: 'Amazon',
        asin,
        title: '検索対象商品 最新モデル',
        brand: 'テスト',
        imageUrl: null,
        price: 800,
        priceText: '目安 ¥800',
        estimate: true,
        rating: 4.5,
        reviews: 120,
        url: productUrl,
      },
    ],
  };

  const { result, errors } = await runInBrowser(async (window) => {
    const doc = window.document;
    const realFetch = window.fetch;
    window.fetch = (url, options) => {
      if (String(url).startsWith('/api/search?')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => fakeSearch });
      }
      return realFetch(url, options);
    };

    click(window, 'btn-search');
    await wait(400);
    const paneOpened = !doc.getElementById('search-pane').classList.contains('hidden');
    const tabs = [...doc.querySelectorAll('#search-providers .search-tab')].map((b) => b.textContent);
    const links = [...doc.querySelectorAll('#search-links a')].length;
    const pastRows = [...doc.querySelectorAll('.pane-history-row .phr-name')].map((n) => n.textContent);

    type(window, 'search-q', '検索対象商品');
    click(window, 'btn-search-run');
    await wait(300);

    const card = doc.querySelector('#search-results .result-card');
    const badge = card ? card.querySelector('.history-badge').textContent : '';
    const price = card ? card.querySelector('.result-price').textContent : '';
    const diff = card ? card.querySelector('.price-diff').textContent : '';

    card.querySelector('.btn-primary').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(300);

    const filled = {
      name: doc.getElementById('input-name').value,
      price: doc.getElementById('input-price').value,
      url: doc.getElementById('input-url').value,
      store: doc.getElementById('input-store').value,
      memo: doc.getElementById('input-memo').value,
    };

    click(window, 'btn-search-close');
    const paneClosed = doc.getElementById('search-pane').classList.contains('hidden');
    return { paneOpened, paneClosed, tabs, links, pastRows, badge, price, diff, filled };
  });

  assert.deepStrictEqual(errors, [], 'フロントでエラーが発生しています');
  assert.strictEqual(result.paneOpened, true, '検索ペインが開きませんでした');
  assert.strictEqual(result.paneClosed, true, '検索ペインが閉じませんでした');
  assert.ok(result.tabs.some((t) => t.includes('すべて')), '検索タブが表示されていません');
  assert.ok(result.links >= 3, '各サイトへの直接リンクが表示されていません');
  assert.ok(result.pastRows.includes('検索対象商品'), 'ペインに購入履歴が表示されていません');
  assert.match(result.badge, /購入履歴あり/, '検索結果に購入履歴バッジが付きませんでした');
  assert.match(result.price, /800/, '検索結果の価格が表示されていません');
  assert.match(result.diff, /200|買い時/, '価格差が表示されていません');
  assert.strictEqual(result.filled.name, '検索対象商品 最新モデル');
  assert.strictEqual(result.filled.price, '800');
  assert.strictEqual(result.filled.url, productUrl);
  assert.strictEqual(result.filled.store, 'Amazon');
  assert.match(result.filled.memo, new RegExp(asin));
});

test('設定ダイアログから Easyparser キーを登録・削除できる', async () => {
  const { result, errors } = await runInBrowser(async (window) => {
    const doc = window.document;
    const actions = [...doc.querySelectorAll('.header-actions .btn')].map((b) => b.textContent);
    const settingsIndex = actions.indexOf('設定');
    const searchIndex = actions.indexOf('通販で検索');

    click(window, 'btn-settings');
    await wait(300);
    const opened = doc.getElementById('settings-dialog').open;
    const path = doc.getElementById('settings-path').textContent;

    type(window, 'settings-easyparser', 'UI-KEY-WXYZ');
    doc.getElementById('settings-usdjpy').value = '140';
    click(window, 'btn-settings-save');
    await wait(400);
    const closedAfterSave = !doc.getElementById('settings-dialog').open;
    const savedToast = doc.getElementById('toast').textContent;

    const { body: saved } = await api('/api/settings');

    click(window, 'btn-settings');
    await wait(300);
    const hint = doc.getElementById('settings-easyparser-hint').textContent;
    const clearVisible = !doc.getElementById('settings-clear-easyparser-label').classList.contains('hidden');
    doc.getElementById('settings-clear-easyparser').checked = true;
    click(window, 'btn-settings-save');
    await wait(400);
    const { body: cleared } = await api('/api/settings');

    return {
      settingsIndex,
      searchIndex,
      opened,
      path,
      closedAfterSave,
      savedToast,
      saved,
      hint,
      clearVisible,
      cleared,
    };
  });

  assert.deepStrictEqual(errors, [], 'フロントでエラーが発生しています');
  assert.ok(result.settingsIndex >= 0 && result.settingsIndex < result.searchIndex, '設定ボタンが通販ボタンの左にありません');
  assert.strictEqual(result.opened, true, '設定ダイアログが開きませんでした');
  assert.match(result.path, /search-config\.json$/);
  assert.strictEqual(result.closedAfterSave, true, '保存後にダイアログが閉じませんでした');
  assert.match(result.savedToast, /保存しました/);
  assert.strictEqual(result.saved.easyparserKey.masked, '****WXYZ');
  assert.strictEqual(result.saved.usdJpy, 140);
  assert.ok(!JSON.stringify(result.saved).includes('UI-KEY-WXYZ'));
  assert.match(result.hint, /\*\*\*\*WXYZ/);
  assert.strictEqual(result.clearVisible, true);
  assert.strictEqual(result.cleared.easyparserKey.configured, false);
});
