'use strict';

const el = (id) => document.getElementById(id);

const state = {
  version: '0.6.0',
  stores: [],
  productNames: [],
  purchases: [],
  stats: null,
  editingId: null,
  importPayload: null,
  search: {
    open: false,
    query: '',
    provider: 'all',
    data: null,
    providers: [],
    credits: null,
    notices: [],
  },
};

const ADD_STORE_VALUE = '__add__';

const SEARCH_LABELS = { amazon: 'Amazon', rakuten: '楽天', yodobashi: 'ヨドバシ.com' };
const SEARCH_STORES = { amazon: 'Amazon', rakuten: '楽天', yodobashi: 'ヨドバシ' };

const yen = (value) =>
  '¥' + Number(value || 0).toLocaleString('ja-JP', { maximumFractionDigits: 2 });

function makeNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function safeUrl(value) {
  const text = String(value == null ? '' : value).trim();
  return /^https?:\/\//i.test(text) ? text : null;
}

function extractAsin(value) {
  const text = String(value == null ? '' : value);
  const patterns = [
    /\/dp\/([A-Z0-9]{10})(?:[\/?#]|$)/i,
    /\/gp\/product\/([A-Z0-9]{10})(?:[\/?#]|$)/i,
    /[?&]asin=([A-Z0-9]{10})(?:[&#]|$)/i,
    /^\s*([A-Z0-9]{10})\s*$/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\-_・、。,"'（）()\[\]【】:：]/g, '');
}

// 検索結果と過去の購入記録を、ASIN → 商品名の順で照合する (クレジット消費なし)
function findPastPurchases(item, purchases) {
  const asin = String(item.asin || '').toUpperCase() || extractAsin(item.url);
  if (asin) {
    const hits = purchases.filter((p) => extractAsin(p.url) === asin);
    if (hits.length) return hits;
  }
  const title = normalizeName(item.title);
  if (title.length < 4) return [];
  return purchases.filter((p) => {
    const name = normalizeName(p.name);
    return name.length >= 4 && (title.includes(name) || name.includes(title));
  });
}

function summarizePurchases(rows) {
  const prices = rows.map((r) => Number(r.price)).filter((n) => Number.isFinite(n));
  if (!prices.length) return null;
  return {
    count: rows.length,
    min: Math.min(...prices),
    max: Math.max(...prices),
    avg: Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100,
  };
}

function todayString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    body = null;
  }
  if (!res.ok) {
    throw new Error(
      (body && (body.error || body.message)) || `リクエストに失敗しました (${res.status})`
    );
  }
  return body;
}

let toastTimer = null;
function toast(message, kind = '') {
  const node = el('toast');
  node.textContent = message;
  node.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 4000);
}

/* ---------- 表示 ---------- */
function renderStores() {
  const select = el('input-store');
  const current = select.value;
  select.innerHTML = '';

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '（未選択）';
  select.appendChild(empty);

  for (const store of state.stores) {
    const option = document.createElement('option');
    option.value = store.name;
    option.textContent = store.name;
    select.appendChild(option);
  }
  const addOption = document.createElement('option');
  addOption.value = ADD_STORE_VALUE;
  addOption.textContent = '＋ 購入店を追加…';
  select.appendChild(addOption);

  if (current && state.stores.some((s) => s.name === current)) {
    select.value = current;
  } else {
    select.value = current === '' ? '' : state.stores.length ? state.stores[0].name : '';
  }
}

function renderProductNames() {
  const list = el('product-name-list');
  list.innerHTML = '';
  for (const item of state.productNames) {
    const option = document.createElement('option');
    option.value = item.name;
    list.appendChild(option);
  }
}

function renderSummary() {
  const card = el('summary-card');
  const stats = state.stats;
  if (!stats || !stats.count) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  el('summary-title').textContent = el('input-name').value.trim();
  el('summary-count').textContent = `購入履歴 ${stats.count} 件 (${stats.firstDate} 〜 ${stats.lastDate})`;
  el('summary-min').textContent = yen(stats.min);
  el('summary-avg').textContent = yen(stats.avg);
  el('summary-max').textContent = yen(stats.max);

  const diffNode = el('summary-diff');
  const price = parseFloat(el('input-price').value);
  if (Number.isFinite(price) && price > 0) {
    const diff = Math.round((price - stats.min) * 100) / 100;
    diffNode.textContent = `${diff > 0 ? '+' : ''}${yen(diff)}`;
    diffNode.className = `summary-value ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}`;
  } else {
    diffNode.textContent = '—';
    diffNode.className = 'summary-value';
  }
}

function renderHistory() {
  const body = el('history-body');
  body.innerHTML = '';
  const name = el('input-name').value.trim();

  if (name) {
    el('list-title').textContent = `「${name}」の購入履歴`;
    el('list-meta').textContent = state.stats ? `最安値 ${yen(state.stats.min)} / 平均 ${yen(
      state.stats.avg
    )} / 最高値 ${yen(state.stats.max)}` : '';
  } else {
    el('list-title').textContent = '購入履歴';
    el('list-meta').textContent = `${state.purchases.length} 件`;
  }

  const empty = el('empty-message');
  if (name) {
    empty.textContent = `「${name}」の購入履歴はまだありません。`;
  } else {
    empty.textContent = 'まだ購入履歴がありません。上のフォームから登録してください。';
  }
  empty.classList.toggle('hidden', state.purchases.length > 0);

  for (const row of state.purchases) {
    const tr = document.createElement('tr');

    const tdDate = document.createElement('td');
    tdDate.className = 'col-date';
    tdDate.textContent = row.date;

    const tdName = document.createElement('td');
    tdName.className = 'col-name';
    tdName.textContent = row.name;

    const tdMemo = document.createElement('td');
    tdMemo.className = 'col-memo';
    tdMemo.textContent = row.memo || '';

    const tdStore = document.createElement('td');
    tdStore.className = 'col-store';
    if (row.store) {
      const tag = document.createElement('span');
      tag.className = 'tag-store';
      tag.textContent = row.store;
      tdStore.appendChild(tag);
    }

    const tdPrice = document.createElement('td');
    tdPrice.className = 'col-price';
    tdPrice.textContent = yen(row.price);

    const tdUrl = document.createElement('td');
    tdUrl.className = 'col-url';
    if (row.url) {
      const link = document.createElement('a');
      link.href = row.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '開く';
      tdUrl.appendChild(link);
    }

    const tdAction = document.createElement('td');
    tdAction.className = 'col-action';

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn-delete';
    edit.textContent = '編集';
    edit.addEventListener('click', () => startEdit(row));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-delete';
    del.textContent = '削除';
    del.addEventListener('click', async () => {
      if (!confirm(`「${row.name}」(${row.date}) の記録を削除しますか？`)) return;
      try {
        await api(`/purchases/${row.id}`, { method: 'DELETE' });
        if (state.editingId === row.id) cancelEdit();
        toast('記録を削除しました', 'ok');
        await refresh();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    tdAction.append(edit, del);

    if (state.editingId === row.id) tr.classList.add('row-editing');

    tr.append(tdDate, tdName, tdMemo, tdStore, tdPrice, tdUrl, tdAction);
    body.appendChild(tr);
  }
}

/* ---------- データ取得 ---------- */
let refreshSeq = 0;

async function refresh() {
  const name = el('input-name').value.trim();
  const query = name ? `?name=${encodeURIComponent(name)}` : '';
  const seq = ++refreshSeq;
  const data = await api(`/state${query}`);
  if (seq !== refreshSeq) return;
  state.version = data.version;
  state.purchases = data.purchases || [];
  state.stats = data.stats;
  state.stores = data.stores || [];
  state.productNames = data.productNames || [];
  el('version').textContent = `v.${data.version}`;
  renderStores();
  renderProductNames();
  renderSummary();
  renderHistory();
  renderPaneHistory();
}

let nameTimer = null;
function scheduleRefresh() {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => {
    refresh().catch((e) => toast(e.message, 'error'));
  }, 180);
}

/* ---------- 操作 ---------- */
function startEdit(row) {
  state.editingId = row.id;
  el('input-date').value = row.date;
  el('input-name').value = row.name;
  el('input-memo').value = row.memo || '';
  el('input-store').value = row.store || '';
  el('input-price').value = row.price;
  el('input-url').value = row.url || '';
  renderStores();

  el('edit-banner').classList.remove('hidden');
  el('edit-banner-text').textContent = `編集中: 「${row.name}」 (${row.date}) — 商品名を変更して「更新」を押してください`;
  el('btn-add').textContent = '更新';
  el('btn-add').classList.add('btn-update');
  document.querySelector('.entry-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  el('input-name').focus();
  el('input-name').select();
  renderHistory();
}

function resetForm(keepName = false) {
  state.editingId = null;
  el('edit-banner').classList.add('hidden');
  el('edit-banner-text').textContent = '編集中';
  el('btn-add').textContent = '追加';
  el('btn-add').classList.remove('btn-update');
  if (!keepName) el('input-name').value = '';
  el('input-memo').value = '';
  el('input-price').value = '';
  el('input-url').value = '';
}

function cancelEdit() {
  resetForm();
  refresh().catch((e) => toast(e.message, 'error'));
  renderHistory();
}

function clearForm() {
  const wasEditing = state.editingId !== null;
  resetForm();
  el('input-date').value = todayString();
  el('input-new-store').value = '';
  el('store-add-row').classList.add('hidden');
  refresh()
    .then(() => {
      toast(wasEditing ? '編集を解除して入力内容をクリアしました' : '入力内容をクリアしました', 'ok');
    })
    .catch((e) => toast(e.message, 'error'));
}

async function submitPurchase() {
  const date = el('input-date').value || todayString();
  const name = el('input-name').value.trim();
  const memo = el('input-memo').value.trim();
  const store = el('input-store').value === ADD_STORE_VALUE ? '' : el('input-store').value;
  const priceRaw = el('input-price').value;
  const url = el('input-url').value.trim();

  if (!name) {
    toast('商品名を入力してください', 'error');
    el('input-name').focus();
    return;
  }
  if (priceRaw === '') {
    toast('今回の値段を入力してください', 'error');
    el('input-price').focus();
    return;
  }

  const editing = state.editingId;
  try {
    await api(editing ? `/purchases/${editing}` : '/purchases', {
      method: editing ? 'PUT' : 'POST',
      body: JSON.stringify({ date, name, memo, store, price: Number(priceRaw), url }),
    });
    const message = editing ? `「${name}」を更新しました` : `「${name}」を登録しました`;
    resetForm(!editing);
    await refresh();
    toast(message, 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function addStore() {
  const input = el('input-new-store');
  const name = input.value.trim();
  if (!name) {
    toast('店名を入力してください', 'error');
    input.focus();
    return;
  }
  try {
    const result = await api('/stores', { method: 'POST', body: JSON.stringify({ name }) });
    state.stores = result.stores;
    renderStores();
    el('input-store').value = name;
    input.value = '';
    el('store-add-row').classList.add('hidden');
    toast(`「${name}」を追加しました`, 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function runUpdate() {
  if (!confirm('GitHub の最新版を取得して再起動します。よろしいですか？')) return;

  const log = el('update-log');
  log.textContent = 'アップデートを実行しています…';
  el('update-dialog').showModal();
  const button = el('btn-update');
  button.disabled = true;
  try {
    const result = await api('/update', {
      method: 'POST',
      body: JSON.stringify({ restart: true }),
    });
    const steps = (result.steps || []).join('\n');
    log.textContent = `${result.message}\n${steps}`;
    toast(result.message, 'ok');
    if (result.restarted) {
      setTimeout(() => window.location.reload(), 4000);
    }
  } catch (e) {
    log.textContent = e.message;
    toast(e.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function restartService() {
  if (!confirm('「買い物リスト管理シート」を再起動しますか？')) return;
  try {
    const result = await api('/restart', { method: 'POST', body: JSON.stringify({}) });
    toast(result.message, 'ok');
    setTimeout(() => window.location.reload(), 4000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

/* ---------- エクスポート / インポート ---------- */
function downloadFile(url) {
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function openExportDialog() {
  el('export-dialog').showModal();
}

function handleImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let payload;
    try {
      payload = JSON.parse(reader.result);
    } catch (e) {
      toast('JSON ファイルとして読み込めませんでした', 'error');
      return;
    }
    const purchases = Array.isArray(payload) ? payload : payload.purchases;
    const stores = Array.isArray(payload) ? [] : payload.stores;
    if (!Array.isArray(purchases)) {
      toast('インポートする購入履歴が見つかりません', 'error');
      return;
    }
    state.importPayload = payload;
    el('import-file').textContent = file.name;
    el('import-count').textContent = purchases.length;
    el('import-stores').textContent = Array.isArray(stores) ? stores.length : 0;
    el('import-dialog').showModal();
  };
  reader.onerror = () => toast('ファイルを読み込めませんでした', 'error');
  reader.readAsText(file);
}

async function runImport() {
  if (!state.importPayload) {
    toast('インポートするファイルを選択してください', 'error');
    return;
  }
  const mode = document.querySelector('input[name="import-mode"]:checked').value;
  const button = el('btn-import-run');
  button.disabled = true;
  try {
    const result = await api('/import', {
      method: 'POST',
      body: JSON.stringify({ data: state.importPayload, mode }),
    });
    el('import-dialog').close();
    state.importPayload = null;
    el('import-file-input').value = '';
    await refresh();
    toast(
      `インポートしました (追加 ${result.inserted} / 更新 ${result.updated} / スキップ ${result.skipped})`,
      'ok'
    );
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ---------- 通販検索の設定 ---------- */
function settingHint(entry) {
  if (!entry.configured) return '未設定';
  const source = entry.source === 'env' ? '（環境変数で設定中・保存より優先）' : '';
  return `保存済み: ${entry.masked} ${source}`;
}

async function openSettingsDialog() {
  try {
    const settings = await api('/settings');
    el('settings-easyparser').value = '';
    el('settings-rakuten').value = '';
    el('settings-easyparser').placeholder = settings.easyparserKey.configured
      ? settings.easyparserKey.masked
      : '未設定';
    el('settings-rakuten').placeholder = settings.rakutenAppId.configured
      ? settings.rakutenAppId.masked
      : '未設定';
    el('settings-easyparser-hint').textContent = settingHint(settings.easyparserKey);
    el('settings-rakuten-hint').textContent = settingHint(settings.rakutenAppId);
    el('settings-clear-easyparser-label').classList.toggle('hidden', !settings.easyparserKey.configured);
    el('settings-clear-rakuten-label').classList.toggle('hidden', !settings.rakutenAppId.configured);
    el('settings-clear-easyparser').checked = false;
    el('settings-clear-rakuten').checked = false;
    el('settings-usdjpy').value = settings.usdJpy;
    el('settings-timeout').value = settings.timeout;
    el('settings-path').textContent = settings.storagePath;
    el('settings-dialog').showModal();
  } catch (e) {
    toast(`設定の読み込みに失敗しました: ${e.message}`, 'error');
  }
}

async function saveSettings() {
  const body = {
    usdJpy: Number(el('settings-usdjpy').value),
    timeout: Number(el('settings-timeout').value),
  };
  const easyparser = el('settings-easyparser').value.trim();
  if (easyparser) body.easyparserKey = easyparser;
  else if (el('settings-clear-easyparser').checked) body.easyparserKey = '';

  const rakuten = el('settings-rakuten').value.trim();
  if (rakuten) body.rakutenAppId = rakuten;
  else if (el('settings-clear-rakuten').checked) body.rakutenAppId = '';

  const button = el('btn-settings-save');
  button.disabled = true;
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify(body) });
    el('settings-dialog').close();
    toast('設定を保存しました', 'ok');
    if (state.search.open) {
      state.search.providers = [];
      await loadSearchProviders();
    }
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ---------- 通販検索ペイン ---------- */
function toggleSearchPane(open) {
  const pane = el('search-pane');
  const willOpen = open === undefined ? pane.classList.contains('hidden') : open;
  pane.classList.toggle('hidden', !willOpen);
  document.body.classList.toggle('search-open', willOpen);
  state.search.open = willOpen;
  el('btn-search').setAttribute('aria-expanded', String(willOpen));
  if (willOpen) {
    if (!state.search.providers.length) loadSearchProviders();
    renderExternalLinks();
    renderPaneHistory();
    setTimeout(() => el('search-q').focus(), 0);
  }
}

async function loadSearchProviders() {
  try {
    const data = await api('/search/providers');
    state.search.providers = data.providers || [];
    state.search.credits = data.credits || null;
    state.search.notices = data.notices || [];
    renderSearchTabs();
    renderSearchCredits();
    renderSearchNotice();
  } catch (e) {
    el('search-note').textContent = `検索設定の取得に失敗しました: ${e.message}`;
  }
}

function renderSearchTabs() {
  const wrap = el('search-providers');
  wrap.innerHTML = '';
  const tabs = [
    { id: 'all', label: 'すべて', kind: 'api', configured: true },
    ...state.search.providers,
  ];
  for (const tab of tabs) {
    const button = makeNode(
      'button',
      `search-tab${state.search.provider === tab.id ? ' active' : ''}`,
      tab.label
    );
    button.type = 'button';
    button.dataset.provider = tab.id;
    if (tab.kind === 'link') button.appendChild(makeNode('span', 'tab-badge', 'リンク'));
    button.addEventListener('click', () => {
      state.search.provider = tab.id;
      renderSearchTabs();
      if (state.search.query) runSearch();
    });
    wrap.appendChild(button);
  }
}

function renderSearchNotice() {
  const wrap = el('search-note');
  wrap.innerHTML = '';
  const extra =
    '検索結果の価格は目安です。実際の価格は商品ページでご確認ください。並び替え・購入履歴との照合は無料です。';
  const dataNotices = state.search.data ? state.search.data.notices || [] : [];
  for (const text of [extra, ...state.search.notices, ...dataNotices]) {
    wrap.appendChild(makeNode('span', 'search-notice-line', text));
  }
}

function renderSearchCredits() {
  const credits = state.search.credits;
  el('search-credits').textContent =
    credits && credits.remaining != null
      ? `Easyparser 残りクレジット ${credits.remaining}` +
        (credits.resetAt ? ` (リセット ${String(credits.resetAt).slice(0, 10)})` : '')
      : '';
}

function fallbackLinks() {
  const q = encodeURIComponent(state.search.query || '');
  return [
    { id: 'amazon', label: 'Amazon', url: `https://www.amazon.co.jp/s?k=${q}` },
    { id: 'rakuten', label: '楽天', url: `https://search.rakuten.co.jp/search/mall/${q}/` },
    { id: 'yodobashi', label: 'ヨドバシ.com', url: `https://www.yodobashi.com/?word=${q}` },
  ];
}

function renderExternalLinks() {
  const wrap = el('search-links');
  wrap.innerHTML = '';
  const data = state.search.data;
  const links = data && data.externalLinks && data.externalLinks.length
    ? data.externalLinks
    : fallbackLinks();
  wrap.appendChild(makeNode('span', 'links-label', '各サイトで直接検索:'));
  for (const link of links) {
    const url = safeUrl(link.url);
    if (!url) continue;
    const anchor = makeNode('a', 'site-link', `${link.label} ↗`);
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    wrap.appendChild(anchor);
  }
}

function sortedSearchItems(items) {
  const sort = el('search-sort').value;
  const price = (item) => (typeof item.price === 'number' ? item.price : Infinity);
  const list = [...items];
  if (sort === 'expensive') list.sort((a, b) => price(b) - price(a));
  else if (sort === 'rating') {
    list.sort(
      (a, b) =>
        (Number(b.rating) || 0) - (Number(a.rating) || 0) ||
        (Number(b.reviews) || 0) - (Number(a.reviews) || 0)
    );
  } else if (sort === 'reviews') {
    list.sort((a, b) => (Number(b.reviews) || 0) - (Number(a.reviews) || 0));
  } else {
    list.sort((a, b) => price(a) - price(b));
  }
  return list;
}

function buildResultCard(item) {
  const card = makeNode('article', 'result-card');
  const top = makeNode('div', 'result-top');
  const label = SEARCH_LABELS[item.provider] || item.providerLabel || item.provider || '通販';
  top.appendChild(makeNode('span', `provider-tag ${item.provider || ''}`, label));
  if (item.brand) top.appendChild(makeNode('span', 'result-brand', item.brand));
  card.appendChild(top);

  const title = makeNode('div', 'result-title');
  const url = safeUrl(item.url);
  if (url) {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = item.title || '（商品名なし）';
    title.appendChild(anchor);
  } else {
    title.textContent = item.title || '（商品名なし）';
  }
  card.appendChild(title);

  const meta = makeNode('div', 'result-meta');
  const rating = Number(item.rating);
  if (Number.isFinite(rating) && rating > 0) meta.appendChild(makeNode('span', 'stars', `★ ${rating}`));
  const reviews = Number(item.reviews);
  if (Number.isFinite(reviews) && reviews > 0) {
    meta.appendChild(makeNode('span', 'review-count', `${reviews}件`));
  }
  if (item.priceText) meta.appendChild(makeNode('strong', 'result-price', item.priceText));
  card.appendChild(meta);

  const past = findPastPurchases(item, state.purchases);
  const stats = past.length ? summarizePurchases(past) : null;
  if (stats) {
    card.appendChild(
      makeNode(
        'div',
        'history-badge',
        `購入履歴あり ${stats.count}件 最安${yen(stats.min)} 平均${yen(stats.avg)}`
      )
    );
    if (typeof item.price === 'number') {
      const diff = Math.round((item.price - stats.min) * 100) / 100;
      const text =
        diff === 0
          ? '過去最安と同額'
          : `${diff > 0 ? '+' : ''}${yen(diff)} ${diff < 0 ? '← 買い時' : '過去最安比'}`;
      card.appendChild(makeNode('div', `price-diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}`, text));
    }
  }

  const actions = makeNode('div', 'result-actions');
  const add = makeNode('button', 'btn btn-small btn-primary', '購入履歴へ追加');
  add.type = 'button';
  add.addEventListener('click', () => prefillFromSearch(item));
  actions.appendChild(add);
  if (url) {
    const link = makeNode('a', 'btn btn-small', '商品ページ ↗');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    actions.appendChild(link);
  }
  card.appendChild(actions);
  return card;
}

function renderSearchResults() {
  const wrap = el('search-results');
  wrap.innerHTML = '';
  const data = state.search.data;
  const items = sortedSearchItems(data && data.items ? data.items : []);
  if (!items.length) {
    wrap.appendChild(
      makeNode('p', 'empty', '検索結果がありません。キーワードを変えるか、上のリンクから各サイトで検索してください。')
    );
    return;
  }
  for (const item of items) wrap.appendChild(buildResultCard(item));
}

function renderPaneHistory() {
  const wrap = el('search-history');
  if (!wrap) return;
  wrap.innerHTML = '';
  const onlyMatches = el('search-only-matches').checked;
  let rows = [...state.purchases];
  if (onlyMatches && state.search.data && state.search.data.items.length) {
    const ids = new Set();
    for (const item of state.search.data.items) {
      for (const purchase of findPastPurchases(item, state.purchases)) ids.add(purchase.id);
    }
    rows = rows.filter((p) => ids.has(p.id));
  }
  if (!rows.length) {
    wrap.appendChild(
      makeNode('p', 'pane-empty', onlyMatches ? '一致する購入履歴はありません。' : '購入履歴がありません。')
    );
    return;
  }
  for (const row of rows) {
    const block = makeNode('div', 'pane-history-row');
    const line1 = makeNode('div', 'phr-line1');
    line1.appendChild(makeNode('span', 'phr-name', row.name));
    line1.appendChild(makeNode('span', 'phr-price', yen(row.price)));
    block.appendChild(line1);

    const line2 = makeNode('div', 'phr-line2');
    line2.appendChild(makeNode('span', 'phr-date', row.date));
    if (row.store) line2.appendChild(makeNode('span', 'phr-store', row.store));
    block.appendChild(line2);

    const actions = makeNode('div', 'phr-actions');
    const searchButton = makeNode('button', 'btn btn-small btn-ghost', 'この商品で検索');
    searchButton.type = 'button';
    searchButton.addEventListener('click', () => {
      el('search-q').value = row.name;
      state.search.query = '';
      runSearch();
    });
    actions.appendChild(searchButton);

    const editButton = makeNode('button', 'btn btn-small btn-ghost', 'フォームで編集');
    editButton.type = 'button';
    editButton.addEventListener('click', () => {
      startEdit(row);
      document.querySelector('.entry-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
    actions.appendChild(editButton);
    block.appendChild(actions);
    wrap.appendChild(block);
  }
}

function prefillFromSearch(item) {
  resetForm();
  el('input-date').value = todayString();
  el('input-name').value = String(item.title || '').trim();
  const store = item.store || SEARCH_STORES[item.provider] || '';
  el('input-store').value = state.stores.some((s) => s.name === store) ? store : '';
  el('input-price').value = typeof item.price === 'number' ? Math.round(item.price) : '';
  el('input-url').value = safeUrl(item.url) || '';

  const label = SEARCH_LABELS[item.provider] || item.providerLabel || item.provider || '通販';
  const parts = [`通販検索 (${label})`];
  const asin = String(item.asin || '').toUpperCase() || extractAsin(item.url);
  if (asin) parts.push(`ASIN: ${asin}`);
  if (item.externalId) parts.push(`商品コード: ${item.externalId}`);
  el('input-memo').value = parts.join(' / ').slice(0, 500);

  renderStores();
  renderSummary();
  refresh().catch((e) => toast(e.message, 'error'));
  document.querySelector('.entry-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  toast('検索結果を入力フォームに転記しました。内容を確認して「追加」を押してください', 'ok');
}

async function runSearch() {
  const q = el('search-q').value.trim();
  if (!q) {
    toast('キーワードを入力してください', 'error');
    el('search-q').focus();
    return;
  }
  state.search.query = q;
  const button = el('btn-search-run');
  button.disabled = true;
  button.textContent = '検索中…';
  el('search-results').innerHTML = '';
  try {
    const query = `?q=${encodeURIComponent(q)}&provider=${encodeURIComponent(state.search.provider)}`;
    const data = await api(`/search${query}`);
    state.search.data = data;
    if (data.credits) state.search.credits = data.credits;
    renderSearchCredits();
    renderExternalLinks();
    renderSearchNotice();
    renderSearchResults();
    renderPaneHistory();
    const failure = (data.notices || []).find((n) => n.includes('失敗'));
    if (failure) toast(failure, 'error');
  } catch (e) {
    el('search-results').innerHTML = '';
    el('search-results').appendChild(makeNode('p', 'empty', `検索に失敗しました: ${e.message}`));
    toast(e.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '検索';
  }
}

/* ---------- 初期化 ---------- */
function bindEvents() {
  el('btn-add').addEventListener('click', submitPurchase);
  el('btn-clear').addEventListener('click', clearForm);
  el('btn-edit-cancel').addEventListener('click', cancelEdit);

  el('input-name').addEventListener('input', scheduleRefresh);

  el('input-price').addEventListener('input', renderSummary);

  el('input-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitPurchase();
    }
  });

  el('input-price').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitPurchase();
    }
  });

  el('input-store').addEventListener('change', (e) => {
    if (e.target.value === ADD_STORE_VALUE) {
      el('store-add-row').classList.remove('hidden');
      el('input-new-store').focus();
    }
  });

  el('btn-store-save').addEventListener('click', addStore);
  el('btn-store-cancel').addEventListener('click', () => {
    el('store-add-row').classList.add('hidden');
    el('input-new-store').value = '';
    renderStores();
  });
  el('input-new-store').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addStore();
    }
  });

  el('btn-update').addEventListener('click', runUpdate);

  // 通販検索の設定
  el('btn-settings').addEventListener('click', openSettingsDialog);
  el('btn-settings-close').addEventListener('click', () => el('settings-dialog').close());
  el('btn-settings-save').addEventListener('click', saveSettings);
  for (const id of ['settings-easyparser', 'settings-rakuten']) {
    el(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveSettings();
      }
    });
  }

  // 通販検索ペイン
  el('btn-search').addEventListener('click', () => toggleSearchPane());
  el('btn-search-close').addEventListener('click', () => toggleSearchPane(false));
  el('btn-search-run').addEventListener('click', runSearch);
  el('search-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });
  el('search-sort').addEventListener('change', renderSearchResults);
  el('search-only-matches').addEventListener('change', renderPaneHistory);
  renderSearchTabs();

  el('btn-export').addEventListener('click', openExportDialog);
  el('btn-export-close').addEventListener('click', () => el('export-dialog').close());
  el('btn-export-json').addEventListener('click', () => {
    downloadFile('/api/export?format=json');
    el('export-dialog').close();
    toast('JSON でエクスポートしました', 'ok');
  });
  el('btn-export-csv').addEventListener('click', () => {
    downloadFile('/api/export?format=csv');
    el('export-dialog').close();
    toast('CSV でエクスポートしました', 'ok');
  });

  el('btn-import').addEventListener('click', () => el('import-file-input').click());
  el('import-file-input').addEventListener('change', (e) => {
    handleImportFile(e.target.files && e.target.files[0]);
  });
  el('btn-import-close').addEventListener('click', () => el('import-dialog').close());
  el('btn-import-run').addEventListener('click', runImport);

  el('btn-update-close').addEventListener('click', () => el('update-dialog').close());

  el('btn-restart').addEventListener('click', restartService);
}

let initialized = false;
async function init() {
  if (initialized) return;
  initialized = true;
  el('input-date').value = todayString();
  bindEvents();
  try {
    await refresh();
    if (!el('input-store').value && state.stores.length) {
      el('input-store').value = state.stores[0].name;
    }
  } catch (e) {
    toast(`読み込みに失敗しました: ${e.message}`, 'error');
  }
}

document.addEventListener('DOMContentLoaded', init);
