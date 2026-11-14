'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// routes の読み込みで本番のデータベースを開かないよう、一時ディレクトリを使う
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppinglist-frontend-'));
process.env.SHOPPINGLIST_DATA_DIR = DATA_DIR;

const routes = require('../src/routes');
const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

// サーバーに登録されているルートを一覧化する
function registeredRoutes() {
  const result = [];
  for (const layer of routes.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      result.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return result;
}

// app.js が呼び出している api() に含まれるパスを抽出する
function apiCalls(source) {
  const calls = [];
  const re = /\bapi\(/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const start = match.index;
    // 呼び出しの閉じ括弧までを取得する
    let depth = 0;
    let end = start;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const body = source.slice(start, end);

    // 呼び出し中の文字列リテラル (パス候補) をすべて取り出す
    const literal = /(['"`])((?:[^'"`\\]|\\.)*)\1/g;
    let lit;
    while ((lit = literal.exec(body)) !== null) {
      const value = lit[2];
      if (!value.startsWith('/')) continue;
      if (value.startsWith('//') || value.includes('://')) continue;
      const routePath = value
        .replace(/\$\{query\}/g, '')
        .replace(/\$\{[^}]+\}/g, ':id');
      calls.push({ path: routePath, raw: value });
    }
  }
  return calls;
}

test('フロントが呼び出すAPIにサーバー側のルートが存在する', () => {
  const registered = registeredRoutes();
  const calls = apiCalls(APP_JS);

  assert.ok(calls.length > 0, 'api() の呼び出しが見つかりません');

  const missing = [];
  for (const call of calls) {
    const found = registered.some((route) => route.path === call.path);
    if (!found) missing.push(`${call.path} (呼び出し: ${call.raw})`);
  }

  assert.deepStrictEqual(
    missing,
    [],
    `フロントが使うAPIにルートがありません:\n${missing.join('\n')}`
  );
});

test('APIパスは /api を二重に前置していない (プレフィックスは api() が付与する)', () => {
  const calls = apiCalls(APP_JS);
  const broken = calls.filter((call) => call.raw.startsWith('/api/')).map((call) => call.raw);
  assert.deepStrictEqual(broken, [], 'api() は /api を付与するため、パスに /api を含めないでください');
});
