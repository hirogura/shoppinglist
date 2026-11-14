'use strict';

const el = (id) => document.getElementById(id);

const state = {
  version: '0.4.0',
  stores: [],
  productNames: [],
  purchases: [],
  stats: null,
  editingId: null,
  importPayload: null,
};

const ADD_STORE_VALUE = '__add__';

const yen = (value) =>
  '¥' + Number(value || 0).toLocaleString('ja-JP', { maximumFractionDigits: 2 });

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

async function init() {
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
