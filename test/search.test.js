'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EMPTY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppinglist-search-empty-'));
process.env.SHOPPINGLIST_DATA_DIR = EMPTY_DATA_DIR;

const search = require('../src/search');

const NO_KEYS = {
  SHOPPINGLIST_DATA_DIR: EMPTY_DATA_DIR,
  EASYPARSER_API_KEY: '',
  RAKUTEN_APP_ID: '',
};
const WITH_KEYS = {
  SHOPPINGLIST_DATA_DIR: EMPTY_DATA_DIR,
  EASYPARSER_API_KEY: 'EASY-SECRET-1234',
  RAKUTEN_APP_ID: 'RAKUTEN-SECRET-5678',
};

test.after(() => {
  fs.rmSync(EMPTY_DATA_DIR, { recursive: true, force: true });
});

function fetchStub(routes, calls) {
  return async (url) => {
    const target = String(url);
    calls.push(target);
    const entry = routes.find((r) => target.startsWith(r.prefix));
    if (!entry) throw new Error(`予期しないURL: ${target}`);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(entry.body),
    };
  };
}

function amazonResponse() {
  return {
    request_info: {
      success: true,
      credits_remaining: 87,
      credits_reset_at: '2026-12-01T00:00:00.000Z',
    },
    result: {
      search: {
        products: [
          {
            asin: 'B000000001',
            title: 'テスト コーヒー 900ml',
            brand: 'テストブランド',
            price: { currency: 'USD', value: '15.00', raw: '$15.00' },
            rating: '4.5',
            ratings_total: 320,
            image_url: 'https://example.com/image.jpg',
          },
          {
            asin: 'B000000002',
            title: 'テスト 洗剤 詰め替え',
            price: { currency: 'JPY', value: '980' },
            rating: '4.7',
            ratings_total: 540,
          },
        ],
      },
    },
  };
}

function rakutenResponse() {
  return {
    Items: [
      {
        Item: {
          itemCode: 'rakuten001',
          itemName: '楽天テスト商品',
          shopName: 'テストショップ',
          itemPrice: 2280,
          itemUrl: 'https://item.rakuten.co.jp/test/rakuten001/',
          reviewAverage: '4.2',
          reviewCount: 98,
          mediumImageUrls: [{ imageUrl: 'https://example.com/rakuten.jpg' }],
        },
      },
    ],
  };
}

test('ASIN を URL と生の文字列から抽出できる', () => {
  assert.strictEqual(search.extractAsin('https://www.amazon.co.jp/dp/B012345678/'), 'B012345678');
  assert.strictEqual(
    search.extractAsin('https://www.amazon.co.jp/gp/product/B012345678?tag=x'),
    'B012345678'
  );
  assert.strictEqual(search.extractAsin('https://www.amazon.co.jp/x?asin=B012345678&tag=x'), 'B012345678');
  assert.strictEqual(search.extractAsin('B012345678'), 'B012345678');
  assert.strictEqual(search.extractAsin('https://example.com/'), null);
});

test('API キー未設定では外部へリクエストせず直接検索リンクを返す', async () => {
  const calls = [];
  const providers = search.getProviders({ env: NO_KEYS, q: 'コーヒー' });
  assert.deepStrictEqual(
    providers.map((p) => [p.id, p.kind, p.configured]),
    [
      ['amazon', 'link', false],
      ['rakuten', 'link', false],
      ['yodobashi', 'link', false],
    ]
  );
  assert.match(providers[0].searchUrl, /amazon\.co\.jp/);
  assert.match(providers[1].searchUrl, /rakuten/);
  assert.match(providers[2].searchUrl, /yodobashi/);

  const result = await search.search({
    q: 'コーヒー',
    provider: 'all',
    env: NO_KEYS,
    fetchImpl: fetchStub([], calls),
  });
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(result.items, []);
  assert.strictEqual(result.externalLinks.length, 3);
  assert.ok(result.notices.some((n) => n.includes('直接検索リンク')));

  const status = search.getStatus({ env: WITH_KEYS });
  assert.deepStrictEqual(status.configured, { amazon: true, rakuten: true, yodobashi: false });
  assert.ok(!JSON.stringify(status).includes('EASY-SECRET-1234'));
  assert.ok(!JSON.stringify(status).includes('RAKUTEN-SECRET-5678'));
});

test('Amazon 検索はサーバー側で API キーを使い、価格目安とクレジットを返す', async () => {
  const calls = [];
  const result = await search.search({
    q: 'コーヒー',
    provider: 'amazon',
    env: WITH_KEYS,
    fetchImpl: fetchStub([{ prefix: 'https://realtime.easyparser.com/', body: amazonResponse() }], calls),
  });

  assert.strictEqual(calls.length, 1);
  const url = new URL(calls[0]);
  assert.strictEqual(url.searchParams.get('api_key'), 'EASY-SECRET-1234');
  assert.strictEqual(url.searchParams.get('platform'), 'AMZ');
  assert.strictEqual(url.searchParams.get('operation'), 'SEARCH');
  assert.strictEqual(url.searchParams.get('domain'), '.co.jp');
  assert.strictEqual(url.searchParams.get('keyword'), 'コーヒー');

  assert.strictEqual(result.items.length, 2);
  assert.strictEqual(result.items[0].provider, 'amazon');
  assert.strictEqual(result.items[0].store, 'Amazon');
  assert.strictEqual(result.items[0].asin, 'B000000001');
  assert.strictEqual(result.items[0].price, 2400, '15 USD × 160 = 2400 円の目安');
  assert.strictEqual(result.items[0].estimate, true);
  assert.strictEqual(result.items[0].url, 'https://www.amazon.co.jp/dp/B000000001');
  assert.strictEqual(result.items[1].price, 980);
  assert.deepStrictEqual(result.credits, { remaining: 87, resetAt: '2026-12-01T00:00:00.000Z' });

  // キーがレスポンスに漏れていないこと
  assert.ok(!JSON.stringify(result).includes('EASY-SECRET-1234'));
});

test('楽天検索は公式 API の結果を本アプリの形式に正規化する', async () => {
  const calls = [];
  const result = await search.search({
    q: 'コーヒー',
    provider: 'rakuten',
    env: WITH_KEYS,
    fetchImpl: fetchStub([{ prefix: 'https://app.rakuten.co.jp/', body: rakutenResponse() }], calls),
  });

  assert.strictEqual(calls.length, 1);
  const url = new URL(calls[0]);
  assert.strictEqual(url.searchParams.get('applicationId'), 'RAKUTEN-SECRET-5678');
  assert.strictEqual(url.searchParams.get('keyword'), 'コーヒー');
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].provider, 'rakuten');
  assert.strictEqual(result.items[0].store, '楽天');
  assert.strictEqual(result.items[0].title, '楽天テスト商品');
  assert.strictEqual(result.items[0].price, 2280);
  assert.strictEqual(result.items[0].externalId, 'rakuten001');
  assert.ok(!JSON.stringify(result).includes('RAKUTEN-SECRET-5678'));
});

test('all 指定では API 結果を統合し、API のないサイトはリンクで案内する', async () => {
  const calls = [];
  const result = await search.search({
    q: 'コーヒー',
    provider: 'all',
    env: WITH_KEYS,
    fetchImpl: fetchStub(
      [
        { prefix: 'https://realtime.easyparser.com/', body: amazonResponse() },
        { prefix: 'https://app.rakuten.co.jp/', body: rakutenResponse() },
      ],
      calls
    ),
  });

  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(
    result.items.map((i) => i.provider),
    ['amazon', 'amazon', 'rakuten']
  );
  assert.ok(result.externalLinks.some((l) => l.id === 'yodobashi' && l.url.includes('yodobashi')));
  assert.ok(result.notices.some((n) => n.includes('ヨドバシ')));
});

test('API エラーにキーが含まれていてもマスクして返す', async () => {
  const calls = [];
  const body = {
    request_info: {
      success: false,
      error_details: [{ message: 'invalid api_key: EASY-SECRET-1234' }],
    },
  };
  const result = await search.search({
    q: 'コーヒー',
    provider: 'amazon',
    env: WITH_KEYS,
    fetchImpl: fetchStub([{ prefix: 'https://realtime.easyparser.com/', body }], calls),
  });

  const notice = result.notices.join(' ');
  assert.match(notice, /Amazon の検索に失敗しました/);
  assert.ok(!notice.includes('EASY-SECRET-1234'), 'API キーがエラー文に漏れています');
  assert.ok(notice.includes('***'));
});

test('空のキーワードでは外部 API を呼ばない', async () => {
  const calls = [];
  const result = await search.search({
    q: '   ',
    provider: 'all',
    env: WITH_KEYS,
    fetchImpl: fetchStub([], calls),
  });
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(result.items, []);
  assert.ok(result.notices.some((n) => n.includes('キーワードを入力')));
});
