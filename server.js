'use strict';

const express = require('express');
const path = require('path');
const routes = require('./src/routes');
const { APP_ROOT } = require('./src/db');

const PORT = Number(process.env.PORT || 3368);
const HOST = process.env.HOST || '0.0.0.0';

const app = express();

app.use(express.json());
app.use(express.static(path.join(APP_ROOT, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: require('./package.json').version });
});

app.use('/api', routes);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'サーバー内部でエラーが発生しました' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`買い物リスト管理シート v${require('./package.json').version}`);
  console.log(`listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
