'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppinglist-settings-'));
const env = { SHOPPINGLIST_DATA_DIR: DATA_DIR };

const config = require('../src/search-config');
const search = require('../src/search');

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('初期状態は未設定で、保存先はワークスペース外のデータディレクトリ', () => {
  const settings = config.getSettings(env);
  assert.strictEqual(settings.easyparserKey.configured, false);
  assert.strictEqual(settings.rakutenAppId.configured, false);
  assert.strictEqual(settings.usdJpy, 160);
  assert.strictEqual(settings.timeout, 45000);
  assert.strictEqual(settings.showImages, false);
  assert.strictEqual(settings.yodobashiViaJina, false);
  assert.strictEqual(settings.storagePath, path.join(DATA_DIR, 'search-config.json'));
  assert.ok(!settings.storagePath.includes('/opt/shoppinglist/'));
});

test('保存したキーはファイルに書き出され、API 向けの値はマスクされる', () => {
  const result = config.save(
    {
      easyparserKey: 'EASY-LIVE-KEY-ABCD1234',
      rakutenAppId: 'RAKUTEN-LIVE-9876',
      usdJpy: 150,
      timeout: 60000,
      showImages: true,
      yodobashiViaJina: true,
    },
    env
  );

  const file = path.join(DATA_DIR, 'search-config.json');
  assert.ok(fs.existsSync(file));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, '設定ファイルの権限が緩すぎます');
  assert.strictEqual(result.easyparserKey.configured, true);
  assert.strictEqual(result.easyparserKey.masked, '****1234');
  assert.strictEqual(result.rakutenAppId.masked, '****9876');
  assert.strictEqual(result.usdJpy, 150);
  assert.strictEqual(result.timeout, 60000);
  assert.strictEqual(result.showImages, true);
  assert.strictEqual(result.yodobashiViaJina, true);
  assert.ok(!JSON.stringify(result).includes('EASY-LIVE-KEY-ABCD1234'));
  assert.ok(!JSON.stringify(result).includes('RAKUTEN-LIVE-9876'));
});

test('空欄の項目は維持され、削除指定の項目だけ消える', () => {
  config.save({ usdJpy: 155 }, env);
  let stored = config.load(env);
  assert.strictEqual(stored.easyparserKey, 'EASY-LIVE-KEY-ABCD1234');
  assert.strictEqual(stored.rakutenAppId, 'RAKUTEN-LIVE-9876');
  assert.strictEqual(stored.usdJpy, 155);
  assert.strictEqual(stored.showImages, true);
  assert.strictEqual(stored.yodobashiViaJina, true);

  config.save({ easyparserKey: '' }, env);
  stored = config.load(env);
  assert.strictEqual(stored.easyparserKey, '');
  assert.strictEqual(stored.rakutenAppId, 'RAKUTEN-LIVE-9876');
});

test('環境変数が設定ファイルより優先され、その旨が分かる', () => {
  config.save({ easyparserKey: 'FILE-KEY-1111' }, env);
  const settings = config.getSettings({
    ...env,
    EASYPARSER_API_KEY: 'ENV-KEY-2222',
  });
  assert.strictEqual(settings.easyparserKey.masked, '****2222');
  assert.strictEqual(settings.easyparserKey.source, 'env');
  assert.strictEqual(settings.rakutenAppId.source, 'file');
});

test('不正な値は保存前に拒否される', () => {
  assert.throws(() => config.save({ easyparserKey: 'x'.repeat(257) }, env), /256 文字以内/);
  assert.throws(() => config.save({ usdJpy: 0 }, env), /円換算レート/);
  assert.throws(() => config.save({ timeout: 10 }, env), /タイムアウト/);
  assert.throws(() => config.save({ showImages: 'maybe' }, env), /画像表示/);
  assert.throws(() => config.save({ yodobashiViaJina: 'maybe' }, env), /ヨドバシ接続/);
  assert.strictEqual(config.load(env).easyparserKey, 'FILE-KEY-1111');
});

test('壊れた設定ファイルは既定値として扱われる', () => {
  const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppinglist-broken-'));
  fs.writeFileSync(path.join(brokenDir, 'search-config.json'), '{ broken');
  const settings = config.getSettings({ SHOPPINGLIST_DATA_DIR: brokenDir });
  assert.strictEqual(settings.easyparserKey.configured, false);
  fs.rmSync(brokenDir, { recursive: true, force: true });
});

test('保存済みのキーを使って Amazon 検索の URL が組み立てられる', async () => {
  const fileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppinglist-search-file-'));
  config.save(
    { easyparserKey: 'STORED-KEY-ABCD', usdJpy: 160, showImages: true },
    { SHOPPINGLIST_DATA_DIR: fileDir }
  );
  assert.strictEqual(
    search.getStatus({ env: { SHOPPINGLIST_DATA_DIR: fileDir } }).showImages,
    true
  );

  const calls = [];
  const result = await search.search({
    q: 'テスト',
    provider: 'amazon',
    env: { SHOPPINGLIST_DATA_DIR: fileDir },
    fetchImpl: async (url) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ request_info: { success: true }, result: {} }),
      };
    },
  });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(new URL(calls[0]).searchParams.get('api_key'), 'STORED-KEY-ABCD');
  assert.ok(!JSON.stringify(result).includes('STORED-KEY-ABCD'));
  fs.rmSync(fileDir, { recursive: true, force: true });
});
