#!/usr/bin/env bash
set -u

HOSTNAME_TO_CHECK="${1:-gateway.msdos.games}"
APP_PORT="${PORT:-3000}"
LOCAL_APP_URL="http://127.0.0.1:${APP_PORT}/health"

pass() { printf 'OK: %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*"; }

printf 'Bear Castle AI HTTPS prerequisite check\n'
printf 'Hostname: %s\n' "$HOSTNAME_TO_CHECK"
printf 'Local app health URL: %s\n\n' "$LOCAL_APP_URL"

if command -v getent >/dev/null 2>&1; then
  if getent ahosts "$HOSTNAME_TO_CHECK" >/dev/null 2>&1; then
    pass "DNS resolves for ${HOSTNAME_TO_CHECK}"
    getent ahosts "$HOSTNAME_TO_CHECK" | head -5
  else
    fail "DNS does not resolve for ${HOSTNAME_TO_CHECK}. Create an A record before requesting a certificate."
  fi
elif command -v dig >/dev/null 2>&1; then
  if dig +short "$HOSTNAME_TO_CHECK" | grep -q .; then
    pass "DNS resolves for ${HOSTNAME_TO_CHECK}"
    dig +short "$HOSTNAME_TO_CHECK"
  else
    fail "DNS does not resolve for ${HOSTNAME_TO_CHECK}. Create an A record before requesting a certificate."
  fi
else
  warn "Neither getent nor dig is available; skipping DNS lookup."
fi

printf '\n'
if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 "$LOCAL_APP_URL" >/dev/null 2>&1; then
    pass "Bear Castle AI responds locally on ${LOCAL_APP_URL}"
  else
    fail "Bear Castle AI did not respond locally on ${LOCAL_APP_URL}. Check PM2, HOST, PORT, and logs."
  fi

  if curl -fsSI --max-time 8 "http://${HOSTNAME_TO_CHECK}" >/dev/null 2>&1; then
    pass "Public HTTP responds on port 80 for ${HOSTNAME_TO_CHECK}"
  else
    warn "Public HTTP did not respond. Let's Encrypt HTTP validation needs port 80 reachable unless you use DNS validation."
  fi

  if curl -fsSI --max-time 8 "https://${HOSTNAME_TO_CHECK}" >/dev/null 2>&1; then
    pass "Public HTTPS responds on port 443 for ${HOSTNAME_TO_CHECK}"
  else
    warn "Public HTTPS did not respond yet. This is expected before configuring Caddy or Nginx/Certbot."
  fi
else
  warn "curl is not available; skipping HTTP checks."
fi

printf '\n'
if command -v ss >/dev/null 2>&1; then
  printf 'Listening ports that matter:\n'
  ss -tulpn 2>/dev/null | grep -E ':(80|443|3000)\b' || warn "No listeners found on 80, 443, or 3000 from ss output."
else
  warn "ss is not available; skipping listener check."
fi

printf '\nManual checks still required:\n'
printf '%s\n' "- DNS A record points ${HOSTNAME_TO_CHECK} to your public IPv4 address."
printf '%s\n' '- Router/NAT forwards TCP 80 and 443 to the gateway VM if it is behind a home router.'
printf '%s\n' '- UFW allows 80/tcp and 443/tcp, but does not expose 3000/tcp publicly.'
printf '%s\n' '- .env uses HOST=127.0.0.1, PORT=3000, SESSION_COOKIE_SECURE=true, and AUTH_TRUST_PROXY=true for HTTPS hosting.'
printf '%s\n' '- local-ai-llm and local-ai-voice remain private and have no public DNS records or port forwards.'
