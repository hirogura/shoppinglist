'use strict';

const { execFile } = require('child_process');
const { APP_ROOT } = require('./db');

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd || APP_ROOT,
        timeout: options.timeout || 120000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: (stdout || '').trim(),
          stderr: (stderr || (error ? error.message : '')).trim(),
        });
      }
    );
  });
}

async function detectRemoteUrl() {
  const result = await runCommand('git', ['remote', 'get-url', 'origin']);
  if (result.code !== 0 || !result.stdout) return '';
  return result.stdout;
}

async function detectBranch() {
  const result = await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.code !== 0 || !result.stdout || result.stdout === 'HEAD') return 'main';
  return result.stdout;
}

async function updateFromGitHub(options = {}) {
  const force = Boolean(options.force);
  const repoUrl = await detectRemoteUrl();
  const steps = [];

  if (!repoUrl) {
    return {
      ok: false,
      message:
        'アップデート元の origin リモートが設定されていません。' +
        'git remote add origin <リポジトリURL> で設定してください。',
      steps,
    };
  }

  const branch = await detectBranch();
  steps.push(`取得元: ${repoUrl} (${branch})`);

  const before = await runCommand('git', ['rev-parse', 'HEAD']);
  steps.push(`更新前: ${before.stdout || '(不明)'}`);

  const status = await runCommand('git', ['status', '--porcelain']);
  if (status.stdout) {
    steps.push(`注意: ローカルの未コミット変更があります (${status.stdout.split('\n').length} 件)`);
  }

  const fetch = await runCommand('git', ['fetch', '--prune', 'origin', branch], {
    timeout: 180000,
  });
  if (fetch.code !== 0) {
    return {
      ok: false,
      message: `取得に失敗しました: ${fetch.stderr || fetch.stdout}`,
      steps,
    };
  }
  steps.push(`取得完了: ${branch}`);

  // ローカルに未 push のコミットがある場合は自動的に破棄しない
  const ancestor = await runCommand('git', ['merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']);
  if (ancestor.code !== 0 && !force) {
    const local = await runCommand('git', ['log', '--oneline', 'FETCH_HEAD..HEAD']);
    return {
      ok: false,
      message:
        'ローカルのコミットがリモートに含まれていないため自動更新できません。' +
        '先に push するか、強制更新でローカルの変更を破棄してください。',
      steps: steps.concat(local.stdout ? [`未 push のコミット:\n${local.stdout}`] : []),
    };
  }
  if (ancestor.code !== 0) {
    steps.push('強制更新: ローカルのコミットを破棄します');
  }

  const reset = await runCommand('git', ['reset', '--hard', 'FETCH_HEAD']);
  if (reset.code !== 0) {
    return {
      ok: false,
      message: `更新の適用に失敗しました: ${reset.stderr || reset.stdout}`,
      steps,
    };
  }
  steps.push(`適用完了: ${reset.stdout}`);

  const clean = await runCommand('git', ['clean', '-fd']);
  if (clean.code === 0 && clean.stdout) steps.push(`不要ファイル削除: ${clean.stdout}`);

  const install = await runCommand('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    timeout: 300000,
  });
  if (install.code !== 0) {
    return {
      ok: false,
      message: `依存関係の更新に失敗しました: ${install.stderr || install.stdout}`,
      steps,
    };
  }
  steps.push('依存関係更新完了');

  const after = await runCommand('git', ['rev-parse', 'HEAD']);
  steps.push(`更新後: ${after.stdout || '(不明)'}`);

  const changed = before.stdout && after.stdout && before.stdout !== after.stdout;
  return {
    ok: true,
    changed,
    message: changed ? 'アップデートを適用しました' : 'すでに最新の状態です',
    steps,
  };
}

module.exports = {
  runCommand,
  updateFromGitHub,
};
