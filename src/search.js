'use strict';

// 通販サイト検索のプロキシ。Easyparser / Rakuten の認証情報はサーバー側の
// 環境変数だけで保持し、レスポンス・HTML・JS には一切含めない。
// API が未設定のサイトは「直接検索リンク」のみを返し、クレジットを消費しない。
// 認証情報は環境変数、またはワークスペース外に保存した設定ファイルから取得する。

const searchConfig = require('./search-config');

const DEFAULT_ENDPOINT = 'https://realtime.easyparser.com/v1/request';
const RAKUTEN_ENDPOINT =
  'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20170706';
const DEFAULT_USD_JPY = 160;
const DEFAULT_TIMEOUT_MS = 45000;
const RESULT_LIMIT = 24;
// ヨドバシ.com は公開 API が無いため、設定で有効なときだけテキスト抽出プロキシを利用する。
// 形式: https://r.jina.ai/<取得したいURL>
const JINA_BASE = 'https://r.jina.ai/';
const YODOBASHI_SEARCH_BASE = 'https://www.yodobashi.com/?word=';

const PROVIDERS = [
  { id: 'amazon', label: 'Amazon', store: 'Amazon', color: '#ff9900' },
  { id: 'rakuten', label: '楽天', store: '楽天', color: '#bf0000' },
  { id: 'yodobashi', label: 'ヨドバシ.com', store: 'ヨドバシ', color: '#e60012' },
];

// 直近の検索で取得した残クレジット (追加リクエストを叩かずに表示する)
let lastCredits = null;

function getConfig(env = process.env) {
  const stored = searchConfig.load(env);
  const key = String(env.EASYPARSER_API_KEY || '').trim() || stored.easyparserKey;
  const rakutenAppId = String(env.RAKUTEN_APP_ID || '').trim() || stored.rakutenAppId;
  const usdJpy = Number(env.SHOPPINGLIST_USD_JPY);
  const timeout = Number(env.SHOPPINGLIST_SEARCH_TIMEOUT);
  return {
    key,
    rakutenAppId,
    endpoint: String(env.EASYPARSER_ENDPOINT || DEFAULT_ENDPOINT),
    rakutenEndpoint: String(env.RAKUTEN_ENDPOINT || RAKUTEN_ENDPOINT),
    usdJpy:
      Number.isFinite(usdJpy) && usdJpy > 0 ? usdJpy : stored.usdJpy || DEFAULT_USD_JPY,
    timeout:
      Number.isFinite(timeout) && timeout >= 1000 ? timeout : stored.timeout || DEFAULT_TIMEOUT_MS,
    yodobashiViaJina: Boolean(stored.yodobashiViaJina),
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
      p.id === 'amazon'
        ? Boolean(cfg.key)
        : p.id === 'rakuten'
          ? Boolean(cfg.rakutenAppId)
          : p.id === 'yodobashi'
            ? cfg.yodobashiViaJina
            : false;
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
  if (cfg.yodobashiViaJina) {
    notices.push(
      'ヨドバシ.com は r.jina.ai 経由で検索結果を取得します (接続できなかった場合は直接検索リンクを表示します)。'
    );
  } else {
    notices.push(
      'ヨドバシ.com は設定で「r.jina.ai 経由でヨドバシ.comに接続する」を有効にすると検索結果を取得できます。'
    );
  }
  return {
    configured: {
      amazon: Boolean(cfg.key),
      rakuten: Boolean(cfg.rakutenAppId),
      yodobashi: cfg.yodobashiViaJina,
    },
    providers,
    credits: lastCredits,
    showImages: searchConfig.getSettings(env).showImages,
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

async function fetchText(url, cfg, fetchImpl, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      ...(headers ? { headers } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, cfg, fetchImpl) {
  const text = await fetchText(url, cfg, fetchImpl, { Accept: 'application/json' });
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (e) {
    json = null;
  }
  if (!json || typeof json !== 'object') throw new Error('JSON 応答を取得できませんでした');
  return json;
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

// Easyparser SEARCH の `image` は "71+vBR2X10L" のような画像 ID で、URL ではない。
// 完全な URL は `main_image.link` に入っている。ID しか無い場合は Amazon の画像 URL を組み立てる。
function resolveImageUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('//')) return `https:${text}`;
  if (/^[A-Za-z0-9+\-_]{6,}$/.test(text)) {
    return `https://m.media-amazon.com/images/I/${text}.jpg`;
  }
  return null;
}

function imageFrom(row) {
  const candidates = [
    // 完全な URL が入っている main_image を優先する
    pick(row, ['main_image', 'mainImage']),
    pick(row, ['image', 'image_url', 'imageUrl', 'thumbnail', 'thumb_image', 'media']),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const url = resolveImageUrl(candidate);
      if (url) return url;
      continue;
    }
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const url = resolveImageUrl(
        pick(candidate, ['link', 'url', 'imageUrl', 'image_url', 'image', 'thumbnail', 'large', 'medium', 'id'])
      );
      if (url) return url;
    }
  }

  const images = pick(row, ['images', 'imageUrls', 'mediumImageUrls']);
  if (Array.isArray(images) && images.length) {
    for (const first of images.slice(0, 3)) {
      if (typeof first === 'string') {
        const url = resolveImageUrl(first);
        if (url) return url;
      } else if (first && typeof first === 'object') {
        const url = resolveImageUrl(
          pick(first, ['link', 'url', 'imageUrl', 'image_url', 'image', 'id'])
        );
        if (url) return url;
      }
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
          image: item.imageUrl,
          images: item.mediumImageUrls,
        },
        index,
        cfg,
        externalId: externalId || null,
      });
    });
  return { items, credits: null };
}

/* ---------- ヨドバシ.com (r.jina.ai のテキスト抽出プロキシ) ---------- */
// r.jina.ai が返す Markdown から商品一覧を取り出す。冒頭 ~1000 行は
// グローバルナビのプロモーション商品なので、「◯件中◯件から◯件までを表示」
// 以降だけを読む (検索結果の前に似た商品が差し込まれるため)。
function parseYodobashiText(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const start = lines.findIndex((line) => /件中\d+件から\d+件までを表示/.test(line));
  if (start === -1) throw new Error('検索結果の一覧が見つかりませんでした');

  const countMatch = lines[start].match(/(\d+)件中/);
  const expected = countMatch ? Number(countMatch[1]) : RESULT_LIMIT;
  const rows = [];
  const seen = new Set();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const product = line.match(/https?:\/\/www\.yodobashi\.com\/product\/(\d+)\//);
    if (product) {
      const id = product[1];
      if (seen.has(id)) {
        // 同じ商品のレビューリンクなど。件数だけ拾って現在の商品の情報を維持する。
        if (current && current.reviews == null) {
          const review = line.match(/userEvaluation\)[^0-9]*(\d+)/);
          if (review) current.reviews = Number(review[1]);
        }
        continue;
      }
      seen.add(id);
      current = {
        id,
        title: null,
        brand: null,
        price: null,
        reviews: null,
        image: null,
        url: product[0],
      };
      const imageUrl = line.match(/https?:\/\/image\.yodobashi\.com\/[^)\s]+/);
      if (imageUrl) {
        current.image = imageUrl[0];
        const altStart = line.lastIndexOf('![', imageUrl.index);
        const altEnd = line.lastIndexOf('](', imageUrl.index);
        if (altStart !== -1 && altEnd > altStart) {
          current.title =
            line
              .slice(altStart + 2, altEnd)
              .replace(/^Image\s+\d+:\s*/i, '')
              .trim() || null;
        }
      }
      rows.push(current);
      continue;
    }
    if (!current) continue;
    if (current.price == null) {
      const price = line.match(/￥\s*([\d,]+)/);
      if (price) current.price = Number(price[1].replace(/,/g, ''));
    }
    if (current.brand == null) {
      const brand = line.match(/^\[([^\]]+)\]\(https?:\/\/www\.yodobashi\.com\/\?mkrbrnds=/);
      if (brand) current.brand = brand[1].trim();
    }
    if (current.reviews == null) {
      const review = line.match(/userEvaluation\)[^0-9]*(\d+)/);
      if (review) current.reviews = Number(review[1]);
    }
  }
  return rows.slice(0, expected);
}

async function runYodobashi(q, cfg, fetchImpl) {
  const target = `${YODOBASHI_SEARCH_BASE}${encodeURIComponent(q)}`;
  const text = await fetchText(`${JINA_BASE}${target}`, cfg, fetchImpl);
  const rows = parseYodobashiText(text);
  const provider = PROVIDERS[2];
  const items = rows.slice(0, RESULT_LIMIT).map((row, index) =>
    makeItem({
      provider: provider.id,
      label: provider.label,
      store: provider.store,
      row: {
        title: row.title,
        brand: row.brand,
        price: row.price,
        url: row.url,
        image: row.image,
        reviews: row.reviews,
      },
      index,
      cfg,
      externalId: row.id,
    })
  );
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
      if (target.id === 'yodobashi') {
        response.notices.push(
          'ヨドバシ.com は設定で「r.jina.ai 経由でヨドバシ.comに接続する」を有効にすると検索結果を取得できます (現在は直接検索リンクを表示します)。'
        );
      } else {
        response.notices.push(`${target.label} は API 未設定のため直接検索リンクを表示します。`);
      }
      continue;
    }
    const run =
      target.id === 'amazon' ? runAmazon : target.id === 'yodobashi' ? runYodobashi : runRakuten;
    tasks.push(
      Promise.resolve()
        .then(() => run(query, cfg, doFetch))
        .then((result) => ({ ok: true, label: target.label, ...result }))
        .catch((e) => ({ ok: false, id: target.id, label: target.label, message: redact(e.message, cfg) }))
    );
  }

  const results = await Promise.all(tasks);
  for (const result of results) {
    if (result.ok) response.items.push(...result.items);
    else if (result.id === 'yodobashi') {
      response.notices.push(
        `ヨドバシ.com への接続に失敗したため、直接検索リンクを表示します (${result.message})。`
      );
    } else response.notices.push(`${result.label} の検索に失敗しました: ${result.message}`);
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
