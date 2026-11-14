'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const APP_ROOT = process.env.SHOPPINGLIST_APP_DIR || path.join(__dirname, '..');
// 登録データは公開リポジトリのワークスペース外に保存する
const DATA_DIR = process.env.SHOPPINGLIST_DATA_DIR || '/opt/shoppinglist-data';
const DB_PATH = path.join(DATA_DIR, 'shoppinglist.db');

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(DATA_DIR, 0o700);
} catch (e) {
  // 権限変更できない環境では無視する
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS purchases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    memo       TEXT    NOT NULL DEFAULT '',
    store      TEXT    NOT NULL DEFAULT '',
    price      REAL    NOT NULL DEFAULT 0,
    url        TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_purchases_name ON purchases(name);
  CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date);

  CREATE TABLE IF NOT EXISTS stores (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
`);

// 既存データベースへのスキーマ変更 (memo カラムの追加)
const purchaseColumns = db.prepare('PRAGMA table_info(purchases)').all().map((c) => c.name);
if (!purchaseColumns.includes('memo')) {
  db.exec("ALTER TABLE purchases ADD COLUMN memo TEXT NOT NULL DEFAULT ''");
}

const DEFAULT_STORES = ['Amazon', '楽天', 'ヨドバシ', 'たのめーる'];

const insertStore = db.prepare('INSERT OR IGNORE INTO stores (name) VALUES (?)');
const seedStores = db.transaction((names) => {
  for (const name of names) insertStore.run(name);
});
seedStores(DEFAULT_STORES);

try {
  fs.chmodSync(DB_PATH, 0o600);
} catch (e) {
  // 権限変更できない環境では無視する
}

function listPurchases(name) {
  const target = (name || '').trim();
  if (!target) {
    return db
      .prepare(
        `SELECT * FROM purchases
         ORDER BY date DESC, id DESC`
      )
      .all();
  }
  return db
    .prepare(
      `SELECT * FROM purchases
       WHERE name = ?
       ORDER BY date DESC, id DESC`
    )
    .all(target);
}

function addPurchase({ date, name, memo, store, price, url }) {
  const info = db
    .prepare(
      `INSERT INTO purchases (date, name, memo, store, price, url)
       VALUES (@date, @name, @memo, @store, @price, @url)`
    )
    .run({ date, name, memo, store, price, url });
  return db.prepare('SELECT * FROM purchases WHERE id = ?').get(info.lastInsertRowid);
}

function updatePurchase(id, { date, name, memo, store, price, url }) {
  const info = db
    .prepare(
      `UPDATE purchases
       SET date = @date, name = @name, memo = @memo, store = @store, price = @price, url = @url
       WHERE id = @id`
    )
    .run({ id, date, name, memo, store, price, url });
  if (info.changes === 0) return null;
  return db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
}

function deletePurchase(id) {
  return db.prepare('DELETE FROM purchases WHERE id = ?').run(id).changes > 0;
}

function statsFor(name) {
  const target = (name || '').trim();
  if (!target) return null;
  const row = db
    .prepare(
      `SELECT COUNT(*)         AS count,
              MIN(price)        AS min,
              MAX(price)        AS max,
              AVG(price)        AS avg,
              MIN(date)         AS firstDate,
              MAX(date)         AS lastDate
       FROM purchases
       WHERE name = ?`
    )
    .get(target);
  if (!row || row.count === 0) return null;
  return {
    count: row.count,
    min: row.min,
    max: row.max,
    avg: Math.round(row.avg * 100) / 100,
    firstDate: row.firstDate,
    lastDate: row.lastDate,
  };
}

function listProductNames() {
  return db
    .prepare(
      `SELECT name, MAX(date) AS lastDate, COUNT(*) AS count
       FROM purchases
       GROUP BY name
       ORDER BY lastDate DESC, name ASC`
    )
    .all();
}

function listStores() {
  return db.prepare('SELECT id, name FROM stores ORDER BY id ASC').all();
}

function addStore(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('店名が空です');
  const existing = db.prepare('SELECT id, name FROM stores WHERE name = ?').get(trimmed);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO stores (name) VALUES (?)').run(trimmed);
  return db.prepare('SELECT id, name FROM stores WHERE id = ?').get(info.lastInsertRowid);
}

/* ---------- エクスポート / インポート ---------- */
function exportData() {
  return {
    purchases: db.prepare('SELECT * FROM purchases ORDER BY id ASC').all(),
    stores: db.prepare('SELECT id, name FROM stores ORDER BY id ASC').all(),
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function normalizePurchase(row) {
  if (!row || typeof row !== 'object') return null;

  const name = String(row.name == null ? '' : row.name).trim();
  if (!name) return null;

  const date = String(row.date == null ? '' : row.date).trim();
  if (!DATE_PATTERN.test(date)) return null;

  const price = Number(row.price);
  if (!Number.isFinite(price) || price < 0) return null;

  const id = Number(row.id);
  return {
    id: Number.isInteger(id) && id > 0 ? id : null,
    date,
    name,
    memo: String(row.memo == null ? '' : row.memo).trim(),
    store: String(row.store == null ? '' : row.store).trim(),
    price,
    url: String(row.url == null ? '' : row.url).trim(),
    created_at: String(row.created_at == null ? '' : row.created_at).trim(),
  };
}

function normalizeStore(row) {
  if (typeof row === 'string') return row.trim() || null;
  if (!row || typeof row !== 'object') return null;
  const name = String(row.name == null ? '' : row.name).trim();
  return name || null;
}

const insertPurchaseWithId = db.prepare(
  `INSERT INTO purchases (id, date, name, memo, store, price, url, created_at)
   VALUES (@id, @date, @name, @memo, @store, @price, @url,
           COALESCE(NULLIF(@created_at, ''), datetime('now', 'localtime')))`
);
const insertPurchase = db.prepare(
  `INSERT INTO purchases (date, name, memo, store, price, url, created_at)
   VALUES (@date, @name, @memo, @store, @price, @url,
           COALESCE(NULLIF(@created_at, ''), datetime('now', 'localtime')))`
);
const updatePurchaseById = db.prepare(
  `UPDATE purchases
   SET date = @date, name = @name, memo = @memo, store = @store, price = @price, url = @url
   WHERE id = @id`
);
const findPurchaseId = db.prepare('SELECT id FROM purchases WHERE id = ?');
const insertStoreIgnore = db.prepare('INSERT OR IGNORE INTO stores (name) VALUES (?)');

const runImport = db.transaction((purchases, stores, mode) => {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  if (mode === 'replace') {
    db.exec('DELETE FROM purchases');
    db.exec('DELETE FROM stores');
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('purchases', 'stores')");
  }

  for (const row of purchases) {
    const purchase = normalizePurchase(row);
    if (!purchase) {
      skipped += 1;
      continue;
    }
    if (purchase.id && findPurchaseId.get(purchase.id)) {
      updatePurchaseById.run(purchase);
      updated += 1;
    } else if (purchase.id) {
      insertPurchaseWithId.run(purchase);
      inserted += 1;
    } else {
      insertPurchase.run(purchase);
      inserted += 1;
    }
  }

  let storeCount = 0;
  for (const row of stores) {
    const name = normalizeStore(row);
    if (!name) continue;
    const info = insertStoreIgnore.run(name);
    if (info.changes > 0) storeCount += 1;
  }

  // 既定の購入店は常に残す
  seedStores(DEFAULT_STORES);

  return { inserted, updated, skipped, stores: storeCount };
});

function importData(payload, mode = 'merge') {
  const source = payload && typeof payload === 'object' ? payload : {};
  const rawPurchases = Array.isArray(source.purchases)
    ? source.purchases
    : Array.isArray(source)
      ? source
      : [];
  const rawStores = Array.isArray(source.stores) ? source.stores : [];

  if (!rawPurchases.length && !rawStores.length) {
    throw new Error('インポートするデータがありません');
  }

  const result = runImport(rawPurchases, rawStores, mode === 'replace' ? 'replace' : 'merge');
  return {
    ...result,
    mode,
    total: result.inserted + result.updated,
    purchases: db.prepare('SELECT COUNT(*) AS count FROM purchases').get().count,
  };
}

module.exports = {
  APP_ROOT,
  DATA_DIR,
  DB_PATH,
  db,
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
};
