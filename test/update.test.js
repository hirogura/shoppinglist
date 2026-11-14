'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const APP_ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shoppinglist-update-'));
const REMOTE_DIR = path.join(TMP, 'remote.git');
const WORK_DIR = path.join(TMP, 'work');
const DATA_DIR = path.join(TMP, 'data');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function commitFile(dir, name, content, message) {
  fs.writeFileSync(path.join(dir, name), content);
  git(['add', '.'], dir);
  git(['commit', '-m', message], dir);
}

let server;
let BASE = '';

function api(pathname, options = {}) {
  return fetch(`${BASE}${pathname}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

test.before(async () => {
  git(['init', '--bare', '-b', 'main', REMOTE_DIR], TMP);
  git(['clone', REMOTE_DIR, WORK_DIR], TMP);
  fs.writeFileSync(
    path.join(WORK_DIR, 'package.json'),
    JSON.stringify({ name: 'shoppinglist-update-test', version: '0.0.0', private: true }, null, 2)
  );
  commitFile(WORK_DIR, 'README.md', 'version 1\n', 'init');
  git(['push', 'origin', 'main'], WORK_DIR);

  const port = await findFreePort();
  BASE = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(APP_ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SHOPPINGLIST_DATA_DIR: DATA_DIR,
      SHOPPINGLIST_APP_DIR: WORK_DIR,
    },
    stdio: 'ignore',
  });

  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) break;
    } catch (e) {
      /* 起動待ち */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

test.after(async () => {
  if (server) server.kill('SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 200));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('更新対象がない場合は「すでに最新」と返す', async () => {
  const { body } = await api('/api/update', { method: 'POST', body: JSON.stringify({ restart: false }) });
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.changed, false);
});

test('リモートに新しいコミットがあると更新される', async () => {
  const other = path.join(TMP, 'other');
  git(['clone', REMOTE_DIR, other], TMP);
  commitFile(other, 'CHANGELOG.md', 'version 2\n', 'add changelog');
  git(['push', 'origin', 'main'], other);

  const { body } = await api('/api/update', { method: 'POST', body: JSON.stringify({ restart: false }) });
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.changed, true);
  assert.ok(fs.existsSync(path.join(WORK_DIR, 'CHANGELOG.md')));
});

test('未 push のローカルコミットがある場合は更新しない', async () => {
  commitFile(WORK_DIR, 'LOCAL.md', 'local\n', 'local commit');

  const { body } = await api('/api/update', { method: 'POST', body: JSON.stringify({ restart: false }) });
  assert.strictEqual(body.ok, false);
  assert.match(body.message, /未 push|リモートに含まれていない/);
  assert.ok(fs.existsSync(path.join(WORK_DIR, 'LOCAL.md')));
});

test('強制更新を明示した場合はローカルコミットを破棄してリモートに合わせる', async () => {
  const { body } = await api('/api/update', {
    method: 'POST',
    body: JSON.stringify({ restart: false, force: true }),
  });
  assert.strictEqual(body.ok, true);
  assert.ok(!fs.existsSync(path.join(WORK_DIR, 'LOCAL.md')));
  assert.ok(fs.existsSync(path.join(WORK_DIR, 'CHANGELOG.md')));
});
