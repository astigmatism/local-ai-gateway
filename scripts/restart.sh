#!/usr/bin/env bash
set -euo pipefail

APP_NAME="local-ai-gateway"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

echo "Building current source before restarting PM2..."
npm run build

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
else
  pm2 start ecosystem.config.cjs --update-env
fi

pm2 save
