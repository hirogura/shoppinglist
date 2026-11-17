'use strict';

// 通販サイト検索のプロキシ。Easyparser / Rakuten の認証情報はサーバー側の
// 環境変数だけで保持し、レスポンス・HTML・JS には一切含めない。
// API が未設定のサイトは「直接検索リンク」のみを返し、クレジットを消費しない。

const DEFAULT_ENDPOINT = 'https://realtime.easyparser.com/v1/request';
const RAKUTEN_ENDPOINT =
  'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20170706';
const DEFAULT_USD_JPY = 160;
const DEFAULT_TIMEOUT_MS = 45000;
const RESULT_LIMIT = 24;

const PROVIDERS = [
  { id: 'amazon', label: 'Amazon', store: 'Amazon', color: '#ff9900' },
  { id: 'rakuten', label: '楽天', store: '楽天', color: '#bf0000' },
  { id: 'yodobashi', label: 'ヨドバシ.com', store: 'ヨドバシ', color: '#e60012' },
];

// 直近の検索で取得した残クレジット (追加リクエストを叩かずに表示する)
let lastCredits = null;

function getConfig(env = process.env) {
  const key = String(env.EASYPARSER_API_KEY || '').trim();
  const rakutenAppId = String(env.RAKUTEN_APP_ID || '').trim();
  const usdJpy = Number(env.SHOPPINGLIST_USD_JPY);
  const timeout = Number(env.SHOPPINGLIST_SEARCH_TIMEOUT);
  return {
    key,
    rakutenAppId,
    endpoint: String(env.EASYPARSER_ENDPOINT || DEFAULT_ENDPOINT),
    rakutenEndpoint: String(env.RAKUTEN_ENDPOINT || RAKUTEN_ENDPOINT),
    usdJpy: Number.isFinite(usdJpy) && usdJpy > 0 ? usdJpy : DEFAULT_USD_JPY,
    timeout: Number.isFinite(timeout) && timeout >= 1000 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

function directSearchUrl(providerId, q = '', env = process.env) {
  const keyword = encodeURIComponent(String(q || '').trim());
  if (providerId === 'amazon') return `https://www.amazon.co.jp/s?k=${keyword}`;
  if (providerId === 'yodobashi') return `https://www.yodobashi.com/?word=${keyword}`;
  if (providerId === 'rakuten') {
    const base = String(env.RAKUTEN_SEARCH_BASE || 'https://search.rakuten.co.jp/search/mall/');
    return `${base}${keyword}/`;
  }
  return '';
}

function getProviders({ env = process.env, q = '' } = {}) {
  const cfg = getConfig(env);
  return PROVIDERS.map((p) => {
    const configured =
      p.id === 'amazon' ? Boolean(cfg.key) : p.id === 'rakuten' ? Boolean(cfg.rakutenAppId) : false;
    return {
      id: p.id,
      label: p.label,
      store: p.store,
      color: p.color,
      kind: configured ? 'api' : 'link',
      configured,
      searchUrl: directSearchUrl(p.id, q, env),
    };
  });
}

function getStatus({ env = process.env } = {}) {
  const cfg = getConfig(env);
  const providers = getProviders({ env }).map(({ searchUrl, ...rest }) => rest);
  const notices = [];
  if (!cfg.key) notices.push('EASYPARSER_API_KEY を設定すると Amazon の商品検索が利用できます。');
  if (!cfg.rakutenAppId) notices.push('RAKUTEN_APP_ID を設定すると 楽天 の商品検索が利用できます。');
  notices.push('ヨドバシ.com は API がないため、直接検索リンクを表示します。');
  return {
    configured: {
      amazon: Boolean(cfg.key),
      rakuten: Boolean(cfg.rakutenAppId),
      yodobashi: false,
    },
    providers,
    credits: lastCredits,
    notices,
  };
}

function redact(text, cfg) {
  let out = String(text == null ? '' : text);
  for (const secret of [cfg.key, cfg.rakutenAppId]) {
    if (secret) out = out.split(secret).join('***');
  }
  return out;
}

async function fetchJson(url, cfg, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {
      json = null;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!json || typeof json !== 'object') throw new Error('JSON 応答を取得できませんでした');
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 値の取り出し ---------- */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const value = obj[key];
    if (value != null && value !== '') return value;
  }
  return null;
}

function numberFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return null;
}

function safeExternalUrl(value) {
  const text = String(value == null ? '' : value).trim();
  return /^https?:\/\//i.test(text) ? text : null;
}

function extractAsin(value) {
  const text = String(value == null ? '' : value);
  const patterns = [
    /\/dp\/([A-Z0-9]{10})(?:[\/?#]|$)/i,
    /\/gp\/product\/([A-Z0-9]{10})(?:[\/?#]|$)/i,
    /\/ASIN\/([A-Z0-9]{10})(?:[\/?#]|$)/i,
    /[?&]asin=([A-Z0-9]{10})(?:[&#]|$)/i,
    /^\s*([A-Z0-9]{10})\s*$/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

function priceInfo(row, cfg) {
  const candidate = pick(row, [
    'price',
    'price_info',
    'buybox_winner',
    'buyBox',
    'buybox',
    'lowest_price',
    'offer',
    'offers',
  ]);
  let raw = candidate;
  let currency = 'JPY';
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    raw = pick(candidate, ['value', 'raw', 'amount', 'price', 'min', 'lowest', 'formatted', 'display']);
    currency = String(
      pick(candidate, ['currency', 'currency_code', 'currencyCode', 'symbol']) || 'JPY'
    );
  }
  let fromUsdField = false;
  if (raw == null) {
    raw = pick(row, ['price_value', 'priceValue', 'price_usd', 'priceUsd', 'priceJpy']);
    fromUsdField = pick(row, ['price_usd', 'priceUsd']) != null;
  }
  const value = numberFrom(raw);
  const upper = currency.toUpperCase();
  const isUsd = fromUsdField || upper === 'USD' || String(raw).includes('$');
  const jpy = value == null ? null : isUsd ? Math.round(value * cfg.usdJpy) : Math.round(value);
  return { value, jpy, isUsd };
}

function imageFrom(row) {
  const direct = pick(row, ['image', 'image_url', 'imageUrl', 'thumbnail', 'main_image']);
  if (typeof direct === 'string') return safeExternalUrl(direct);
  if (direct && typeof direct === 'object') {
    return safeExternalUrl(pick(direct, ['url', 'imageUrl', 'image_url', 'large', 'medium']));
  }
  const images = pick(row, ['images', 'imageUrls', 'mediumImageUrls']);
  if (Array.isArray(images) && images.length) {
    const first = images[0];
    if (typeof first === 'string') return safeExternalUrl(first);
    if (first && typeof first === 'object') {
      return safeExternalUrl(pick(first, ['url', 'imageUrl', 'image_url']));
    }
  }
  return null;
}

function makeItem({ provider, label, store, row, index, cfg, externalId, asinOverride }) {
  const asin = asinOverride || extractAsin(pick(row, ['asin', 'ASIN', 'product_id', 'productId']));
  const url = safeExternalUrl(pick(row, ['url', 'link', 'product_url', 'productUrl', 'itemUrl']));
  const resolvedAsin = asin || extractAsin(url);
  const price = priceInfo(row, cfg);
  const rating = numberFrom(pick(row, ['rating', 'stars', 'review_rating', 'reviewAverage']));
  const reviews = numberFrom(
    pick(row, ['ratings_total', 'reviews', 'review_count', 'reviewCount', 'num_reviews'])
  );
  return {
    id: `${provider}:${resolvedAsin || externalId || index}`,
    provider,
    providerLabel: label,
    store,
    asin: resolvedAsin,
    externalId: externalId || null,
    title: String(pick(row, ['title', 'name', 'product_title', 'itemName']) || '商品名なし'),
    brand: pick(row, ['brand', 'manufacturer', 'shopName']) || null,
    imageUrl: imageFrom(row),
    price: price.jpy,
    priceText: price.jpy == null ? '価格不明' : `目安 ${formatYen(price.jpy)}`,
    estimate: true,
    rating: rating,
    reviews: reviews,
    url: url || (resolvedAsin ? `https://www.amazon.co.jp/dp/${resolvedAsin}` : null),
  };
}

function formatYen(value) {
  return `¥${Number(value).toLocaleString('ja-JP')}`;
}

/* ---------- Amazon (Easyparser SEARCH) ---------- */
function creditsFrom(json) {
  const info = json && json.request_info;
  if (!info || (info.credits_remaining == null && !info.credits_reset_at)) return null;
  return {
    remaining: info.credits_remaining == null ? null : Number(info.credits_remaining),
    resetAt: info.credits_reset_at || null,
  };
}

function collectAmazonRows(json) {
  const result = json && json.result ? json.result : json || {};
  const search = result.search || result;
  const containers = [
    search.products,
    search.items,
    search.results,
    search.search_results,
    search.data && search.data.products,
    search.data && search.data.items,
    result.products,
    result.items,
    result.results,
  ];
  const rows = [];
  const seen = new Set();
  for (const container of containers) {
    if (!Array.isArray(container)) continue;
    for (const row of container) {
      if (!row || typeof row !== 'object') continue;
      const title = pick(row, ['title', 'name', 'product_title']);
      const asin = extractAsin(pick(row, ['url', 'link', 'product_url']));
      if (!title && !asin) continue;
      const key = String(pick(row, ['asin', 'ASIN', 'product_id', 'productId']) || title || asin);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

async function runAmazon(q, cfg, fetchImpl) {
  const params = new URLSearchParams({
    api_key: cfg.key,
    platform: 'AMZ',
    operation: 'SEARCH',
    domain: '.co.jp',
    language: 'ja_JP',
    currency: 'jpy',
    keyword: q,
  });
  const separator = cfg.endpoint.includes('?') ? '&' : '?';
  const json = await fetchJson(`${cfg.endpoint}${separator}${params}`, cfg, fetchImpl);
  if (json.request_info && json.request_info.success === false) {
    const details = (json.request_info.error_details || [])
      .map((d) => (d && (d.message || d.detail || d.description)) || d)
      .join(' / ');
    throw new Error(details || 'Easyparser が検索を処理できませんでした');
  }
  const credits = creditsFrom(json);
  if (credits) lastCredits = credits;
  const rows = collectAmazonRows(json);
  const provider = PROVIDERS[0];
  const items = rows
    .slice(0, RESULT_LIMIT)
    .map((row, index) =>
      makeItem({
        provider: provider.id,
        label: provider.label,
        store: provider.store,
        row,
        index,
        cfg,
      })
    );
  return { items, credits };
}

/* ---------- 楽天 (楽天市場 商品検索 API) ---------- */
async function runRakuten(q, cfg, fetchImpl) {
  const params = new URLSearchParams({
    applicationId: cfg.rakutenAppId,
    keyword: q,
    format: 'json',
    hits: String(RESULT_LIMIT),
  });
  const separator = cfg.rakutenEndpoint.includes('?') ? '&' : '?';
  const json = await fetchJson(`${cfg.rakutenEndpoint}${separator}${params}`, cfg, fetchImpl);
  const items = (json.Items || [])
    .map((entry) => entry && entry.Item)
    .filter(Boolean)
    .slice(0, RESULT_LIMIT)
    .map((item, index) => {
      const externalId = String(item.itemCode || '');
      return makeItem({
        provider: PROVIDERS[1].id,
        label: PROVIDERS[1].label,
        store: PROVIDERS[1].store,
        row: {
          title: item.itemName,
          brand: item.shopName,
          price: item.itemPrice,
          url: item.itemUrl,
          rating: item.reviewAverage,
          reviews: item.reviewCount,
          images: item.mediumImageUrls,
        },
        index,
        cfg,
        externalId: externalId || null,
      });
    });
  return { items, credits: null };
}

/* ---------- 横断検索 ---------- */
async function search({ q, provider = 'all', env = process.env, fetchImpl } = {}) {
  const cfg = getConfig(env);
  const query = String(q || '').trim();
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (...args) => fetch(...args);
  const providers = getProviders({ env, q: query });
  const response = {
    query,
    provider,
    providers: providers.map(({ searchUrl, ...rest }) => rest),
    credits: lastCredits,
    notices: [],
    items: [],
    externalLinks: providers.map(({ id, label, store, searchUrl }) => ({
      id,
      label,
      store,
      url: searchUrl,
    })),
  };

  if (!query) {
    response.notices.push('キーワードを入力してください。');
    return response;
  }

  const selected = providers.filter((p) => provider === 'all' || p.id === provider);
  if (!selected.length) {
    response.notices.push('不明な検索サイトです。');
    return response;
  }

  const tasks = [];
  for (const target of selected) {
    if (target.kind === 'link') {
      response.notices.push(`${target.label} は API 未設定のため直接検索リンクを表示します。`);
      continue;
    }
    tasks.push(
      Promise.resolve()
        .then(() => (target.id === 'amazon' ? runAmazon(query, cfg, doFetch) : runRakuten(query, cfg, doFetch)))
        .then((result) => ({ ok: true, label: target.label, ...result }))
        .catch((e) => ({ ok: false, label: target.label, message: redact(e.message, cfg) }))
    );
  }

  const results = await Promise.all(tasks);
  for (const result of results) {
    if (result.ok) response.items.push(...result.items);
    else response.notices.push(`${result.label} の検索に失敗しました: ${result.message}`);
  }
  response.credits = lastCredits;
  return response;
}

module.exports = {
  PROVIDERS,
  getConfig,
  getProviders,
  getStatus,
  search,
  extractAsin,
  redact,
};
