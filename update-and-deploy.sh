#!/usr/bin/env bash
set -euo pipefail

APP_NAME="local-ai-gateway"
BRANCH="main"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$PROJECT_DIR"

log() {
  printf '\n[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

fail() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

restart_existing_service() {
  if command_exists pm2 && pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    log "Restarting existing PM2 service after failure: $APP_NAME"
    pm2 restart "$APP_NAME" --update-env || true
  fi
}

trap 'restart_existing_service' ERR

[ -d .git ] || fail "This script must be run from the repository root or placed in the repository root."
[ -f package.json ] || fail "package.json was not found in $PROJECT_DIR."
[ -f ecosystem.config.cjs ] || fail "ecosystem.config.cjs was not found in $PROJECT_DIR."

command_exists git || fail "git is not installed or not on PATH."
command_exists npm || fail "npm is not installed or not on PATH."
command_exists pm2 || fail "pm2 is not installed or not on PATH."

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$CURRENT_BRANCH" = "$BRANCH" ] || fail "Expected branch '$BRANCH' but current branch is '$CURRENT_BRANCH'."

if [ -n "$(git status --porcelain)" ]; then
  git status --short
  fail "Working tree has local changes. Commit, stash, or discard them before deploying."
fi

log "Fetching latest code from origin/$BRANCH"
git fetch origin "$BRANCH"

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "origin/$BRANCH")"
BASE_SHA="$(git merge-base HEAD "origin/$BRANCH")"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  log "Repository is already up to date."
elif [ "$LOCAL_SHA" = "$BASE_SHA" ]; then
  log "Fast-forward update is available."
else
  fail "Local branch has diverged from origin/$BRANCH. Resolve manually before deploying."
fi

log "Stopping PM2 service if it is running: $APP_NAME"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 stop "$APP_NAME"
else
  log "PM2 service is not currently registered; it will be started after build."
fi

log "Pulling latest code"
git pull --ff-only origin "$BRANCH"

log "Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci --include=dev
else
  npm install --include=dev
fi

log "Generating Prisma client"
npm run db:generate

log "Applying database migrations"
npm run db:migrate

log "Building application"
npm run build

log "Starting PM2 service: $APP_NAME"
trap - ERR
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
else
  pm2 start ecosystem.config.cjs --update-env
fi

pm2 save
pm2 status "$APP_NAME"

log "Deployment complete."
