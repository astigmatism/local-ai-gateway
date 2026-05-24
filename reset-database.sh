#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

APP_NAME="${PM2_APP_NAME:-local-ai-gateway}"

if [[ ! -f ".env" ]]; then
  echo "ERROR: .env was not found in $PROJECT_ROOT"
  exit 1
fi

if [[ ! -f "prisma/schema.prisma" ]]; then
  echo "ERROR: prisma/schema.prisma was not found. Run this from the project root."
  exit 1
fi

if [[ "${1:-}" != "--yes" ]]; then
  echo "DANGER: This will permanently reset the Local AI Gateway database."
  echo
  echo "It will:"
  echo "  - Stop the PM2 app if it is running"
  echo "  - Drop all application tables/data"
  echo "  - Re-apply Prisma migrations"
  echo "  - Recreate the default/admin user using .env"
  echo "  - Build the current source into dist before any PM2 restart"
  echo "  - Clear uploaded audio files under storage/uploads"
  echo "  - Restart the PM2 app if PM2 is available"
  echo
  echo "Database URL target:"
  node --env-file=.env -e "const url = new URL(process.env.DATABASE_URL); console.log(url.protocol + '//' + url.username + ':REDACTED@' + url.host + url.pathname)"
  echo
  read -r -p "Type RESET to continue: " confirmation

  if [[ "$confirmation" != "RESET" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "Checking required tools..."
command -v node >/dev/null
command -v npm >/dev/null
command -v npx >/dev/null

echo "Stopping PM2 app if it is running..."
if command -v pm2 >/dev/null 2>&1; then
  pm2 stop "$APP_NAME" >/dev/null 2>&1 || true
fi

echo "Generating Prisma client before reset/bootstrap..."
npx prisma generate

echo "Resetting database with Prisma..."
npx prisma migrate reset --force --skip-seed

echo "Re-applying deployed migrations to confirm clean state..."
npx prisma migrate deploy

echo "Running seed/bootstrap..."
npm run db:seed

echo "Building current source before restarting PM2..."
npm run build

echo "Clearing uploaded audio files..."
mkdir -p storage/uploads
find storage/uploads -type f ! -name ".gitkeep" -delete

echo "Restarting PM2 app if available..."
if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env
  else
    echo "PM2 app '$APP_NAME' was not found; skipping restart."
  fi
else
  echo "PM2 not found; skipping restart."
fi

echo
echo "Database reset complete."
