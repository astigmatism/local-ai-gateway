#!/usr/bin/env bash
set -euo pipefail

APP_NAME="local-ai-gateway"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if [ ! -d node_modules ]; then
  if [ -f package-lock.json ]; then
    npm ci
  else
    npm install
  fi
fi

if [ ! -f dist/server/index.js ] || [ ! -f dist/client/index.html ]; then
  npm run build
fi

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
else
  pm2 start ecosystem.config.cjs --update-env
fi

pm2 save
