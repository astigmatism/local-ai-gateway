#!/usr/bin/env bash
set -euo pipefail

APP_NAME="local-ai-gateway"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 stop "$APP_NAME"
fi

if [ -d .git ]; then
  git pull --ff-only
else
  echo "No .git directory found; skipping git pull."
fi

if [ -f package-lock.json ]; then
  npm ci --omit=
else
  npm install --omit=
fi

npm run db:generate
npm run db:migrate
npm run build

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
else
  pm2 start ecosystem.config.cjs --update-env
fi

pm2 save
