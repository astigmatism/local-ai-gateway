#!/usr/bin/env bash

set -euo pipefail

# package-for-ai.sh
#
# Packages the project source into a zip file suitable for sharing with an AI model.
#
# Usage:
#   ./package-for-ai.sh [destination-directory]
#
# Examples:
#   ./package-for-ai.sh
#   ./package-for-ai.sh ~/Desktop
#   ./package-for-ai.sh /tmp/ai-export
#
# Notes:
#   - The script packages the directory where this script resides.
#   - It excludes common generated files, dependency folders, caches, logs,
#     OS metadata, editor settings, and local secrets.
#   - Works on macOS and Linux.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="$(basename "$SCRIPT_DIR")"

DEST_DIR="${1:-"$SCRIPT_DIR/ai-packages"}"
TIMESTAMP="$(date +"%Y%m%d-%H%M%S")"
ZIP_NAME="${PROJECT_NAME}-source-${TIMESTAMP}.zip"
ZIP_PATH="$DEST_DIR/$ZIP_NAME"

mkdir -p "$DEST_DIR"

if ! command -v zip >/dev/null 2>&1; then
  echo "Error: 'zip' is not installed or not available on PATH." >&2
  exit 1
fi

echo "Packaging project:"
echo "  Source:      $SCRIPT_DIR"
echo "  Destination: $ZIP_PATH"
echo

cd "$SCRIPT_DIR"

zip -r "$ZIP_PATH" . \
  -x "$ZIP_NAME" \
  -x "ai-packages/*" \
  -x ".git/*" \
  -x ".svn/*" \
  -x ".hg/*" \
  -x "node_modules/*" \
  -x "dist/*" \
  -x "build/*" \
  -x "coverage/*" \
  -x ".next/*" \
  -x ".nuxt/*" \
  -x ".svelte-kit/*" \
  -x ".astro/*" \
  -x ".vite/*" \
  -x ".turbo/*" \
  -x ".cache/*" \
  -x ".parcel-cache/*" \
  -x ".eslintcache" \
  -x ".tsbuildinfo" \
  -x "*.tsbuildinfo" \
  -x "npm-debug.log*" \
  -x "yarn-debug.log*" \
  -x "yarn-error.log*" \
  -x "pnpm-debug.log*" \
  -x "*.log" \
  -x ".DS_Store" \
  -x "._*" \
  -x "__MACOSX/*" \
  -x ".idea/*" \
  -x ".vscode/*" \
  -x "*.swp" \
  -x "*.swo" \
  -x ".env" \
  -x ".env.*" \
  -x "*.pem" \
  -x "*.key" \
  -x "*.crt" \
  -x "*.p12" \
  -x "*.pfx" \
  -x "tmp/*" \
  -x "temp/*" \
  -x ".tmp/*"

echo
echo "Created:"
echo "  $ZIP_PATH"
