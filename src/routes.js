'use strict';

const express = require('express');
const {
  listPurchases,
  addPurchase,
  updatePurchase,
  deletePurchase,
  statsFor,
  listProductNames,
  listStores,
  addStore,
  exportData,
  importData,
} = require('./db');
const { updateFromGitHub } = require('./git');
const { scheduleRestart } = require('./service');
const searchService = require('./search');
const searchConfig = require('./search-config');

const router = express.Router();

function todayString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

router.get('/state', (req, res) => {
  const name = (req.query.name || '').toString().trim();
  res.json({
    version: require('../package.json').version,
    today: todayString(),
    purchases: listPurchases(name),
    stats: statsFor(name),
    productNames: listProductNames(),
    stores: listStores(),
  });
});

router.get('/purchases', (req, res) => {
  const name = (req.query.name || '').toString().trim();
  res.json({ purchases: listPurchases(name), stats: statsFor(name) });
});

router.get('/stats', (req, res) => {
  const name = (req.query.name || '').toString().trim();
  res.json({ stats: statsFor(name) });
});

/* ---------- 通販検索の設定 (キーはワークスペース外のファイルに保存) ---------- */
router.get('/settings', (req, res) => {
  res.json(searchConfig.getSettings());
});

router.put('/settings', (req, res) => {
  try {
    const settings = searchConfig.save(req.body || {});
    res.json({ ok: true, settings });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ---------- 通販検索 (Easyparser / 楽天はサーバー側でのみ認証情報を利用) ---------- */
router.get('/search/providers', (req, res) => {
  res.json(searchService.getStatus());
});

router.get('/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const provider = (req.query.provider || 'all').toString().trim();
  try {
    res.json(await searchService.search({ q, provider }));
  } catch (e) {
    res.status(500).json({ error: '検索に失敗しました' });
  }
});

function parsePurchaseBody(body) {
  const name = (body.name || '').toString().trim();
  const date = (body.date || '').toString().trim() || todayString();
  const memo = (body.memo || '').toString().trim();
  const store = (body.store || '').toString().trim();
  const url = (body.url || '').toString().trim();
  const price = Number(body.price);

  if (!name) return { error: '商品名を入力してください' };
  if (!Number.isFinite(price) || price < 0) {
    return { error: '値段を正しく入力してください' };
  }
  if (url && !/^https?:\/\//i.test(url)) {
    return { error: 'URLは http(s) で始まる必要があります' };
  }
  if (memo.length > 500) {
    return { error: 'メモは500文字以内で入力してください' };
  }

  return { value: { date, name, memo, store, price, url } };
}

router.post('/purchases', (req, res) => {
  const parsed = parsePurchaseBody(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { date, name, memo, store, price, url } = parsed.value;

  try {
    if (store) addStore(store);
    const purchase = addPurchase({ date, name, memo, store, price, url });
    res.status(201).json({ purchase, stats: statsFor(name) });
  } catch (e) {
    res.status(500).json({ error: `登録に失敗しました: ${e.message}` });
  }
});

router.put('/purchases/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '不正なIDです' });

  const parsed = parsePurchaseBody(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { date, name, memo, store, price, url } = parsed.value;

  try {
    if (store) addStore(store);
    const purchase = updatePurchase(id, { date, name, memo, store, price, url });
    if (!purchase) return res.status(404).json({ error: '該当する記録がありません' });
    res.json({ purchase, stats: statsFor(name) });
  } catch (e) {
    res.status(500).json({ error: `更新に失敗しました: ${e.message}` });
  }
});

router.delete('/purchases/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '不正なIDです' });
  const removed = deletePurchase(id);
  if (!removed) return res.status(404).json({ error: '該当する記録がありません' });
  res.json({ ok: true, id });
});

router.get('/stores', (req, res) => {
  res.json({ stores: listStores() });
});

/* ---------- エクスポート / インポート ---------- */
function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(purchases) {
  const header = ['日付', '商品名', 'メモ', '購入店', '値段', 'URL'];
  const rows = purchases.map((p) =>
    [p.date, p.name, p.memo || '', p.store || '', p.price, p.url || ''].map(csvCell).join(',')
  );
  return [header.join(','), ...rows].join('\r\n') + '\r\n';
}

router.get('/export', (req, res) => {
  const data = exportData();
  const format = (req.query.format || 'json').toString().toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="shoppinglist-${stamp}.csv"`);
    res.send('\uFEFF' + toCsv(data.purchases));
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="shoppinglist-${stamp}.json"`);
  res.send(
    JSON.stringify(
      {
        app: 'shoppinglist',
        version: require('../package.json').version,
        exportedAt: new Date().toISOString(),
        purchases: data.purchases,
        stores: data.stores,
      },
      null,
      2
    )
  );
});

router.post('/import', (req, res) => {
  const body = req.body || {};
  const mode = (body.mode || 'merge').toString() === 'replace' ? 'replace' : 'merge';
  const payload = body.data !== undefined ? body.data : body;
  try {
    const result = importData(payload, mode);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/stores', (req, res) => {
  const name = (req.body && req.body.name ? req.body.name : '').toString().trim();
  if (!name) return res.status(400).json({ error: '店名を入力してください' });
  try {
    const store = addStore(name);
    res.status(201).json({ store, stores: listStores() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/update', async (req, res) => {
  try {
    const result = await updateFromGitHub({ force: Boolean(req.body && req.body.force) });
    if (result.ok && req.body && req.body.restart !== false) {
      scheduleRestart(2000);
      result.restarted = true;
    }
    res.status(result.ok ? 200 : 500).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, message: `アップデートに失敗しました: ${e.message}` });
  }
});

router.post('/restart', (req, res) => {
  const unit = scheduleRestart(800);
  res.json({ ok: true, message: '再起動を実行しました', unit });
});

module.exports = router;
