'use strict';

// selfmark と同じコンセプトの Tailnet 内同期:
// ・同期元 (source) は相手へデータを push、同期先 (destination) は相手から pull
// ・1日1回・指定時刻以降に自動同期、手動でも即時実行可能
// ・設定を保存すると相手の役割を反対に自動でそろえる
// ・設定ファイルはワークスペース外 (/opt/shoppinglist-data) に保存

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');
const { DATA_DIR, exportData, replaceAllData } = require('./db');

const CONFIG_FILE = path.join(DATA_DIR, 'sync-config.json');
const ROLE_SOURCE = 'source';
const ROLE_DEST = 'destination';
const DEFAULT_PORT = 3368;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const DEFAULT_CONFIG = {
  role: ROLE_SOURCE,
  peer: '',
  peer_name: '',
  sync_time: '03:00',
  last_sync: '',
  last_result: '',
};

let syncRunning = false;
let schedulerStarted = false;

/* ---------- 設定ファイル ---------- */
function readConfig() {
  const config = { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (typeof parsed[key] === 'string') config[key] = parsed[key];
      }
    }
  } catch (e) {
    // ファイルが無い / 壊れている場合は既定値で起動する
  }
  if (config.role !== ROLE_SOURCE && config.role !== ROLE_DEST) config.role = ROLE_SOURCE;
  if (!TIME_PATTERN.test(config.sync_time)) config.sync_time = DEFAULT_CONFIG.sync_time;
  return config;
}

function writeConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const temp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(temp, 0o600);
  } catch (e) {
    // 権限変更できないファイルシステムでは無視する
  }
  fs.renameSync(temp, CONFIG_FILE);
  return config;
}

function markResult(ok, message) {
  try {
    const config = readConfig();
    config.last_sync = ok ? localStamp() : config.last_sync;
    config.last_result = String(message || '').slice(0, 300);
    writeConfig(config);
  } catch (e) {
    // 結果記録の失敗で同期自体を壊さない
  }
}

function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function publicConfig() {
  return readConfig();
}

/* ---------- Tailnet のピア一覧 ---------- */
function selfPort(env = process.env) {
  const port = Number(env.PORT);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

function defaultRunner(command, args, callback) {
  execFile(command, args, { timeout: 10000, maxBuffer: 10 * 1024 * 1024 }, callback);
}

function getStatus(runner = defaultRunner) {
  return new Promise((resolve) => {
    runner('tailscale', ['status', '--json'], (error, stdout) => {
      if (error || !stdout) return resolve(null);
      try {
        const data = JSON.parse(stdout);
        resolve(data && typeof data === 'object' ? data : null);
      } catch (e) {
        resolve(null);
      }
    });
  });
}

function cleanDns(value) {
  return String(value || '').replace(/\.$/, '');
}

async function getSelfInfo({ runner = defaultRunner, env = process.env } = {}) {
  const status = await getStatus(runner);
  const self = (status && status.Self) || {};
  const dns = cleanDns(self.DNSName);
  return {
    dns,
    name: String(self.HostName || ''),
    url: dns ? `https://${dns}:${selfPort(env)}` : '',
  };
}

async function getPeerList({ runner = defaultRunner, env = process.env } = {}) {
  const status = await getStatus(runner);
  if (!status) return [];
  const selfDns = cleanDns(status.Self && status.Self.DNSName);
  const port = selfPort(env);
  const peers = status.Peer && typeof status.Peer === 'object' ? status.Peer : {};
  const result = [];
  for (const peer of Object.values(peers)) {
    if (!peer || typeof peer !== 'object') continue;
    const dns = cleanDns(peer.DNSName);
    if (!dns || dns === selfDns) continue;
    result.push({
      name: String(peer.HostName || dns),
      dns,
      url: `https://${dns}:${port}`,
      ip: Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs[0] || '' : '',
      online: Boolean(peer.Online),
    });
  }
  result.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

/* ---------- HTTP (Tailnet の自己署名証明書を許容) ---------- */
function httpJson(url, { method = 'GET', body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(new Error('URL が不正です'));
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      reject(new Error('URL は http(s) で指定してください'));
      return;
    }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(
      target,
      {
        method,
        rejectUnauthorized: false,
        timeout,
        headers: {
          'User-Agent': 'shoppinglist-sync',
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (e) {
            reject(new Error('JSON 応答を取得できませんでした'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('タイムアウトしました')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function isValidPeerUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 500) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch (e) {
    return false;
  }
}

function endpoint(peerUrl, name) {
  return `${String(peerUrl).replace(/\/+$/, '')}/api/sync/${name}`;
}

function validateInput(body) {
  const data = body && typeof body === 'object' ? body : {};
  const role = String(data.role || '');
  const peer = String(data.peer || '').trim();
  const peerName = String(data.peer_name || '').trim().slice(0, 100);
  const syncTime = String(data.sync_time || '').trim();
  if (role !== ROLE_SOURCE && role !== ROLE_DEST) {
    throw new Error('同期元・同期先のいずれかを指定してください');
  }
  if (peer && !isValidPeerUrl(peer)) throw new Error('同期相手の URL が不正です');
  if (!TIME_PATTERN.test(syncTime)) throw new Error('同期時刻は HH:MM 形式で指定してください');
  return { role, peer, peerName, syncTime };
}

/* ---------- 設定の保存・役割連動 ---------- */
async function saveConfig(body, { deps = {} } = {}) {
  const input = validateInput(body);
  const config = readConfig();
  const oldTime = config.sync_time;
  config.role = input.role;
  config.peer = input.peer;
  config.peer_name = input.peerName;
  config.sync_time = input.syncTime;
  if (input.syncTime !== oldTime) {
    config.last_sync = '';
    config.last_result = '同期時刻を変更したため、当日の同期済みフラグをリセットしました';
  }
  writeConfig(config);

  let peerNotified = false;
  let peerMessage = '';
  if (config.peer && body.notify_peer !== false) {
    const opposite = config.role === ROLE_SOURCE ? ROLE_DEST : ROLE_SOURCE;
    const self = await getSelfInfo({ runner: deps.runner, env: deps.env });
    const requestJson = deps.requestJson || httpJson;
    try {
      await requestJson(endpoint(config.peer, 'role'), {
        method: 'POST',
        timeout: 10000,
        body: {
          role: opposite,
          peer_url: self.url,
          peer_name: self.name,
          sync_time: config.sync_time,
        },
      });
      peerNotified = true;
      peerMessage = `相手側を「${opposite === ROLE_DEST ? '同期先' : '同期元'}」に切り替え、同期時刻（${config.sync_time}）を共有しました`;
    } catch (e) {
      peerMessage = `相手側への通知に失敗しました（相手も最新版に更新してください）: ${e.message}`;
    }
  }
  return { peer_notified: peerNotified, peer_message: peerMessage, config: publicConfig() };
}

function applyPeerRole(body) {
  const data = body && typeof body === 'object' ? body : {};
  const role = String(data.role || '');
  if (role !== ROLE_SOURCE && role !== ROLE_DEST) throw new Error('役割が不正です');
  const peerUrl = String(data.peer_url || '').trim();
  if (peerUrl && !isValidPeerUrl(peerUrl)) throw new Error('peer_url が不正です');
  const config = readConfig();
  const oldTime = config.sync_time;
  config.role = role;
  if (peerUrl) {
    config.peer = peerUrl;
    config.peer_name = String(data.peer_name || '').trim().slice(0, 100);
  }
  const syncTime = String(data.sync_time || '').trim();
  if (TIME_PATTERN.test(syncTime)) {
    config.sync_time = syncTime;
    if (syncTime !== oldTime) {
      config.last_sync = '';
      config.last_result = '同期時刻を変更したため、当日の同期済みフラグをリセットしました';
    }
  }
  writeConfig(config);
  return { role: config.role, sync_time: config.sync_time };
}

async function stopSync(body, { deps = {} } = {}) {
  const config = readConfig();
  const oldPeer = config.peer;
  config.peer = '';
  config.peer_name = '';
  config.last_result = `同期を停止しました（${localStamp()}）`;
  writeConfig(config);

  let peerNotified = false;
  let peerMessage = '';
  if (oldPeer && !(body && body.notify_peer === false)) {
    const self = await getSelfInfo({ runner: deps.runner, env: deps.env });
    const requestJson = deps.requestJson || httpJson;
    try {
      const result = await requestJson(endpoint(oldPeer, 'unlink'), {
        method: 'POST',
        timeout: 10000,
        body: { peer_url: self.url },
      });
      peerNotified = Boolean(result && result.unlinked);
      peerMessage = peerNotified
        ? '相手側の同期設定も解除しました'
        : '相手側への通知は届きましたが、相手の相手指定は既に外れていました';
    } catch (e) {
      peerMessage = `相手側への通知に失敗しました（相手側でも停止してください）: ${e.message}`;
    }
  }
  return { peer_notified: peerNotified, peer_message: peerMessage, config: publicConfig() };
}

function unlink(body) {
  const data = body && typeof body === 'object' ? body : {};
  const peerUrl = String(data.peer_url || '').trim().replace(/\/+$/, '');
  const config = readConfig();
  let unlinked = false;
  if (peerUrl && config.peer.replace(/\/+$/, '') === peerUrl) {
    config.peer = '';
    config.peer_name = '';
    config.last_result = '相手側で同期が停止されたため、相手指定を解除しました';
    writeConfig(config);
    unlinked = true;
  }
  return { unlinked };
}

/* ---------- バンドルの送受信 ---------- */
function buildBundle() {
  const data = exportData();
  return {
    version: 1,
    exported_at: localStamp(),
    data: { purchases: data.purchases, stores: data.stores },
  };
}

function applyBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('不正な同期データです');
  const data = bundle.data;
  if (!data || typeof data !== 'object' || !Array.isArray(data.purchases)) {
    throw new Error('不正な同期データです');
  }
  replaceAllData({ purchases: data.purchases, stores: data.stores });
}

async function push(peerUrl, deps = {}) {
  if (!isValidPeerUrl(peerUrl)) throw new Error('同期先が未設定です');
  const bundle = buildBundle();
  const requestJson = deps.requestJson || httpJson;
  try {
    await requestJson(endpoint(peerUrl, 'import'), {
      method: 'POST',
      body: bundle,
      timeout: 60000,
    });
  } catch (e) {
    throw new Error(`送信に失敗しました: ${e.message}`);
  }
  markResult(true, `同期しました（送信・${bundle.exported_at}）`);
  return bundle.exported_at;
}

async function pull(peerUrl, deps = {}) {
  if (!isValidPeerUrl(peerUrl)) throw new Error('同期元が未設定です');
  const requestJson = deps.requestJson || httpJson;
  let bundle;
  try {
    bundle = await requestJson(endpoint(peerUrl, 'export'), { timeout: 60000 });
  } catch (e) {
    throw new Error(`取得に失敗しました: ${e.message}`);
  }
  applyBundle(bundle);
  markResult(true, `同期しました（受信・${bundle.exported_at || ''}）`);
  return bundle.exported_at || '';
}

async function runNow(deps = {}) {
  const config = readConfig();
  if (!config.peer) throw new Error('同期相手が未設定です。先に相手を選択して保存してください');
  if (syncRunning) throw new Error('同期を実行中です。しばらく待ってください');
  syncRunning = true;
  try {
    if (config.role === ROLE_SOURCE) {
      const at = await push(config.peer, deps);
      return { ok: true, direction: 'push', message: `同期先へ送信しました（${at}）` };
    }
    if (config.role === ROLE_DEST) {
      const at = await pull(config.peer, deps);
      return { ok: true, direction: 'pull', message: `同期元から取得しました（${at}）` };
    }
    throw new Error('役割が不正です');
  } catch (e) {
    markResult(false, `手動同期に失敗しました: ${e.message}`);
    throw e;
  } finally {
    syncRunning = false;
  }
}

/* ---------- 自動同期 ---------- */
async function schedulerTick(now = new Date(), deps = {}) {
  const config = readConfig();
  if (!config.peer || !isValidPeerUrl(config.peer)) return false;
  const currentTime = localStamp(now).slice(11, 16);
  if (currentTime < config.sync_time) return false;
  const lastDate = String(config.last_sync || '').slice(0, 10);
  if (lastDate === localStamp(now).slice(0, 10)) return false;
  if (syncRunning) return false;

  syncRunning = true;
  try {
    if (config.role === ROLE_SOURCE) await push(config.peer, deps);
    else if (config.role === ROLE_DEST) await pull(config.peer, deps);
    else return false;
    return true;
  } catch (e) {
    markResult(false, `自動同期に失敗しました: ${e.message}`);
    return false;
  } finally {
    syncRunning = false;
  }
}

function startScheduler(deps = {}) {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const timer = setInterval(() => {
    schedulerTick(new Date(), deps).catch(() => {});
  }, 30000);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
  CONFIG_FILE,
  ROLE_SOURCE,
  ROLE_DEST,
  DEFAULT_CONFIG,
  readConfig,
  writeConfig,
  publicConfig,
  getSelfInfo,
  getPeerList,
  isValidPeerUrl,
  saveConfig,
  applyPeerRole,
  stopSync,
  unlink,
  buildBundle,
  applyBundle,
  push,
  pull,
  runNow,
  schedulerTick,
  startScheduler,
};
