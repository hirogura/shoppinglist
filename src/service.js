'use strict';

const { spawn } = require('child_process');

const SERVICE_UNIT = process.env.SHOPPINGLIST_SERVICE_UNIT || 'shoppinglist.service';

/**
 * 自身を再起動する。
 * HTTP レスポンスを返しきってから実行するため、実行は少し遅らせる。
 */
function scheduleRestart(delayMs = 1200) {
  setTimeout(() => {
    const child = spawn('systemctl', ['restart', SERVICE_UNIT], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  }, delayMs);
  return SERVICE_UNIT;
}

module.exports = { scheduleRestart, SERVICE_UNIT };
