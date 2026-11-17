'use strict';

// 通販検索の認証情報はリポジトリ外 (/opt/shoppinglist-data) の JSON ファイルに保存する。
// API レスポンスには完全なキーを一切含めず、マスク済みの値だけを返す。

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'search-config.json';
const KEY_MAX_LENGTH = 256;
const DEFAULTS = {
  easyparserKey: '',
  rakutenAppId: '',
  usdJpy: 160,
  timeout: 45000,
  showImages: false,
};

function configPath(env = process.env) {
  const dataDir = String(env.SHOPPINGLIST_DATA_DIR || '/opt/shoppinglist-data');
  return path.join(dataDir, FILE_NAME);
}

function normalizeKey(value) {
  const text = String(value == null ? '' : value)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  if (text.length > KEY_MAX_LENGTH) {
    throw new Error(`キーは ${KEY_MAX_LENGTH} 文字以内で入力してください`);
  }
  return text;
}

function positiveNumber(value, fallback, min, max, label) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new Error(`${label} は ${min} 〜 ${max} の数値で入力してください`);
  }
  return num;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(text)) return true;
  if (['false', '0', 'off', 'no', ''].includes(text)) return false;
  throw new Error('画像表示の設定が不正です');
}

function load(env = process.env) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath(env), 'utf8'));
  } catch (e) {
    // ファイルが無い / 壊れている場合は既定値として扱う (上書きで修復できる)
    return { ...DEFAULTS, updatedAt: null };
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS, updatedAt: null };
  return {
    easyparserKey: typeof parsed.easyparserKey === 'string' ? parsed.easyparserKey : '',
    rakutenAppId: typeof parsed.rakutenAppId === 'string' ? parsed.rakutenAppId : '',
    usdJpy:
      Number(parsed.usdJpy) > 0 ? Number(parsed.usdJpy) : DEFAULTS.usdJpy,
    timeout:
      Number(parsed.timeout) >= 1000 ? Number(parsed.timeout) : DEFAULTS.timeout,
    showImages: parsed.showImages === true,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
  };
}

function save(values = {}, env = process.env) {
  const current = load(env);
  const next = {
    easyparserKey: current.easyparserKey,
    rakutenAppId: current.rakutenAppId,
    usdJpy: current.usdJpy,
    timeout: current.timeout,
    showImages: current.showImages,
  };

  // 送信された項目だけ更新する。空文字は「削除」として扱う。
  if (Object.prototype.hasOwnProperty.call(values, 'easyparserKey')) {
    next.easyparserKey = normalizeKey(values.easyparserKey);
  }
  if (Object.prototype.hasOwnProperty.call(values, 'rakutenAppId')) {
    next.rakutenAppId = normalizeKey(values.rakutenAppId);
  }
  if (Object.prototype.hasOwnProperty.call(values, 'usdJpy')) {
    next.usdJpy = positiveNumber(values.usdJpy, DEFAULTS.usdJpy, 1, 10000, '円換算レート');
  }
  if (Object.prototype.hasOwnProperty.call(values, 'timeout')) {
    next.timeout = positiveNumber(values.timeout, DEFAULTS.timeout, 1000, 300000, 'タイムアウト');
  }
  if (Object.prototype.hasOwnProperty.call(values, 'showImages')) {
    next.showImages = normalizeBoolean(values.showImages);
  }
  next.updatedAt = new Date().toISOString();

  const file = configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(temp, 0o600);
  } catch (e) {
    // 権限変更できないファイルシステムでは無視する
  }
  fs.renameSync(temp, file);
  return getSettings(env);
}

function mask(value) {
  const text = String(value || '');
  if (!text) return '';
  return text.length <= 4 ? '****' : `****${text.slice(-4)}`;
}

function getSettings(env = process.env) {
  const stored = load(env);
  const envKey = String(env.EASYPARSER_API_KEY || '').trim();
  const envRakuten = String(env.RAKUTEN_APP_ID || '').trim();
  const envUsdJpy = Number(env.SHOPPINGLIST_USD_JPY);
  const envTimeout = Number(env.SHOPPINGLIST_SEARCH_TIMEOUT);

  const effective = {
    easyparserKey: envKey || stored.easyparserKey,
    rakutenAppId: envRakuten || stored.rakutenAppId,
    usdJpy: Number.isFinite(envUsdJpy) && envUsdJpy > 0 ? envUsdJpy : stored.usdJpy,
    timeout:
      Number.isFinite(envTimeout) && envTimeout >= 1000 ? envTimeout : stored.timeout,
  };

  return {
    easyparserKey: {
      configured: Boolean(effective.easyparserKey),
      masked: mask(effective.easyparserKey),
      source: envKey ? 'env' : stored.easyparserKey ? 'file' : null,
    },
    rakutenAppId: {
      configured: Boolean(effective.rakutenAppId),
      masked: mask(effective.rakutenAppId),
      source: envRakuten ? 'env' : stored.rakutenAppId ? 'file' : null,
    },
    usdJpy: effective.usdJpy,
    timeout: effective.timeout,
    showImages: stored.showImages,
    updatedAt: stored.updatedAt,
    storagePath: configPath(env),
  };
}

module.exports = {
  FILE_NAME,
  DEFAULTS,
  configPath,
  load,
  save,
  getSettings,
  mask,
};
