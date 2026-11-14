#!/bin/bash
# 買い物リスト管理シート のインストールスクリプト
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="shoppinglist.service"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}"
DATA_DIR="/opt/shoppinglist-data"

echo "[install] データ保存ディレクトリを作成しています: ${DATA_DIR}"
install -d -m 700 "${DATA_DIR}"

echo "[install] 依存関係をインストールしています: ${APP_DIR}"
cd "${APP_DIR}"
npm install --omit=dev --no-audit --no-fund

echo "[install] systemd ユニットを配置しています: ${UNIT_PATH}"
cp "${APP_DIR}/deploy/shoppinglist.service" "${UNIT_PATH}"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

sleep 2
systemctl --no-pager --lines=5 status "${SERVICE_NAME}" || true

# Tailnet 経由での公開 (他のサービスと同様の構成)
if command -v tailscale >/dev/null 2>&1; then
  echo "[install] tailscale serve で 3368 番ポートを公開します"
  tailscale serve --https=3368 --bg http://127.0.0.1:3368 || echo "[install] tailscale serve の設定に失敗しました (手動で設定してください)"
  tailscale serve status || true
fi

echo "[install] 完了しました: http://127.0.0.1:3368/"
