#!/usr/bin/env bash
set -euo pipefail

APP_NAME="local-ai-gateway"

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 stop "$APP_NAME"
else
  echo "$APP_NAME is not registered with PM2."
fi
