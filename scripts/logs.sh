#!/usr/bin/env bash
set -euo pipefail

pm2 logs local-ai-gateway "$@"
