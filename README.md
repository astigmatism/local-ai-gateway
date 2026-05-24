# Bear Castle AI local AI gateway

Bear Castle AI is a lightweight browser application for a local AI lab. It runs on a gateway VM and provides a ChatGPT-like UI for two existing local AI service VMs:

- `local-ai-llm` at `192.168.1.5`, running Ollama with `qwen3:30b`
- `local-ai-voice` at `192.168.1.8`, running faster-whisper speech-to-text

The browser talks only to this gateway. The gateway backend calls the LLM, voice/STT, health, and GPU telemetry APIs on the internal network.

## 1. Overview

Chosen stack:

- Node.js 24
- TypeScript
- React + Vite frontend
- Express backend
- Prisma ORM
- PostgreSQL
- PM2 for production process management
- Pino structured logging
- Zod request/config validation

Core features:

- OS-style login screen with user tiles
- Password authentication with first-login password changes
- Eric as the default administrator account
- Admin-only user creation, deactivation, and password reset
- Server-side session storage with HTTP-only cookies and CSRF protection
- Login lockout and endpoint rate limiting
- Conversation persistence in PostgreSQL
- Previous conversation browsing scoped to the signed-in user
- Local-LLM generated titles for new conversations
- Chat prompt submission to Ollama
- Browser voice snippet recording with MediaRecorder
- Audio forwarding to `local-ai-voice /transcribe`
- Transcript append-to-input behavior before sending
- Optional local-LLM transcript punctuation/paragraph cleanup for unformatted STT output
- Markdown-rendered assistant responses
- Cached health/GPU telemetry for both AI VMs after login
- PM2 startup after reboot
- Deployment helper scripts

## 2. Architecture

```text
Browser
  |
  | HTTPS to gateway VM, or localhost/loopback HTTP for local testing
  v
Bear Castle AI gateway VM
  - React/Vite static frontend
  - Express JSON/multipart API
  - Prisma/PostgreSQL persistence
  - server-side auth sessions
  - in-memory telemetry cache
  |
  | Browser never calls these directly
  +--> local-ai-llm   http://192.168.1.5:11434/api/generate
  |                   http://192.168.1.5:8000/health
  |                   http://192.168.1.5:8000/gpu
  |
  +--> local-ai-voice http://192.168.1.8:8000/transcribe
                      http://192.168.1.8:8000/health
                      http://192.168.1.8:8000/gpu
```

The backend serves the frontend in production from `dist/client` and exposes APIs under `/api/*`. The unauthenticated public API surface is intentionally small: login users, login, and `/health`. Conversation, status/GPU, transcription, LLM generation, and user-management APIs require authentication.

## HTTPS/domain hosting quick start

For internet exposure on an owned domain such as `gateway.msdos.games` or `gateway.crazyerics.com`, use a TLS-terminating reverse proxy in front of the Node app. The recommended setup is:

```text
Browser -> HTTPS :443 -> Caddy or Nginx on the gateway VM -> http://127.0.0.1:3000 -> Bear Castle AI
```

Do not run Node directly on port 443 and do not expose Ollama, `local-ai-llm`, `local-ai-voice`, STT, or monitor endpoints directly. Keep the app process private with `HOST=127.0.0.1` and `PORT=3000`, open/forward only TCP `80` and `443`, and terminate HTTPS with Caddy or Nginx/Certbot.

The detailed command-oriented guide is in [`docs/HTTPS_DEPLOYMENT.md`](docs/HTTPS_DEPLOYMENT.md). It covers DNS records, router/NAT forwarding, UFW, Caddy automatic HTTPS, Nginx + Certbot, self-signed certificates for lab use, secure cookies, microphone recording over HTTPS, validation commands, and troubleshooting.


## 3. Existing service dependencies

Default service URLs are configured in `.env`:

```env
LLM_BASE_URL=http://192.168.1.5:11434
LLM_MONITOR_BASE_URL=http://192.168.1.5:8000
LLM_MODEL=qwen3:30b
VOICE_BASE_URL=http://192.168.1.8:8000
```

These are defaults only. Change them in `.env` if the service IPs or ports change.

## 4. Gateway VM requirements

Recommended VM:

- Hostname: `local-ai-gateway`
- OS: Ubuntu Server 24.04 LTS
- vCPU: 4
- RAM: 8 GB
- Disk: 20 GB or larger
- Network access to `192.168.1.5` and `192.168.1.8`

## 5. Install system packages

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg git build-essential postgresql postgresql-contrib
```

Optional but useful:

```bash
sudo apt install -y ufw htop unzip
```

If UFW is enabled and the gateway should be reachable from your LAN, allow port 3000:

```bash
sudo ufw allow 3000/tcp
```

For internet exposure, prefer exposing only 80/443 through a reverse proxy and avoid opening the gateway port directly to the public internet.

Chrome and other modern browsers expose microphone recording APIs only in a secure context. Use HTTPS for LAN hostnames, LAN IPs, and any domain-based access. Plain HTTP microphone recording is suitable only for `localhost` or loopback local testing.

## 6. Install Node.js 24

Use one Node.js installation method. For a production VM, the NodeSource APT repository is convenient because Node is managed through APT.

```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

Expected major versions:

```text
node v24.x.x
npm 11.x.x or newer
```

Do not install Ubuntu's default `nodejs` package if it is not Node 24. This project declares `node >=24` in `package.json`.

## 7. Install PostgreSQL

If you did not already install PostgreSQL in step 5:

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

Confirm it is running:

```bash
systemctl status postgresql --no-pager
```

## 8. Create database/user

Open a PostgreSQL shell:

```bash
sudo -u postgres psql
```

Run the SQL below. Replace `change_me` with a strong local password and use the same password in `.env`.

```sql
CREATE DATABASE local_ai_gateway;
CREATE USER local_ai_gateway WITH ENCRYPTED PASSWORD 'change_me';
GRANT ALL PRIVILEGES ON DATABASE local_ai_gateway TO local_ai_gateway;
\c local_ai_gateway
GRANT ALL ON SCHEMA public TO local_ai_gateway;
ALTER SCHEMA public OWNER TO local_ai_gateway;
\q
```

## 9. Configure `.env`

From the project root:

```bash
cp .env.example .env
nano .env
```

At minimum, update the database URL and decide where Node should listen:

```env
DATABASE_URL=postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway
HOST=127.0.0.1
PORT=3000
```

For HTTPS hosting behind Caddy or Nginx, keep `HOST=127.0.0.1` so the Node app is reachable only from the local reverse proxy. For temporary LAN-only testing without a reverse proxy, you may use `HOST=0.0.0.0`, but do not expose that port to the public internet.

Generate strong authentication values before starting the production app:

```bash
openssl rand -base64 48
```

Set all of these to non-placeholder values before running `npm run db:seed` or starting the app with `NODE_ENV=production`:

```env
INITIAL_ADMIN_PASSWORD=<strong initial Eric password>
NEW_USER_DEFAULT_PASSWORD=<strong temporary password for new users>
SESSION_SECRET=<long random value from openssl rand -base64 48>
AUTH_MIN_PASSWORD_LENGTH=8
AUTH_MAX_FAILED_LOGIN_ATTEMPTS=3
AUTH_LOCKOUT_WINDOW_MINUTES=5
AUTH_LOCKOUT_DURATION_MINUTES=5
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAME_SITE=lax
AUTH_TRUST_PROXY=true
CSRF_ENABLED=true
SECURITY_HEADERS_ENABLED=true
```

Passwords must be at least 8 characters. `INITIAL_ADMIN_PASSWORD` and `NEW_USER_DEFAULT_PASSWORD` must also be at least 8 characters. Failed-login cooldown starts after 3 failed attempts and lasts 5 minutes by default. These authentication policy values can be changed through the environment variables above.

`NODE_ENV` defaults to `production` in this application. That means `npm run db:seed` intentionally fails when these values are missing or still set to `change_this...` placeholders. If you see `Invalid production authentication configuration`, edit `.env`, replace the placeholder auth values, and run the seed command again.

For local development over plain HTTP, set `SESSION_COOKIE_SECURE=false`. For HTTPS production, keep `SESSION_COOKIE_SECURE=true`; secure cookies require HTTPS at the browser. When the app is behind Caddy or Nginx, keep `AUTH_TRUST_PROXY=true` so Express understands the proxy's HTTPS headers.

Review these service defaults:

```env
LLM_BASE_URL=http://192.168.1.5:11434
LLM_MONITOR_BASE_URL=http://192.168.1.5:8000
LLM_MODEL=qwen3:30b
VOICE_BASE_URL=http://192.168.1.8:8000
```

If the voice/STT service returns a raw unpunctuated transcript, the gateway can optionally ask the configured local Ollama model to restore punctuation, capitalization, sentence boundaries, and paragraph breaks before appending the transcript to the input box. This is disabled by default to preserve the direct STT behavior and avoid an extra LLM call. Enable it only when needed:

```env
TRANSCRIPT_FORMATTING_ENABLED=true
TRANSCRIPT_FORMATTING_TIMEOUT_MS=120000
TRANSCRIPT_FORMATTING_MODEL=qwen3:30b
TRANSCRIPT_FORMATTING_MAX_CHARS=12000
```

If transcript formatting fails, the gateway falls back to the raw STT transcript so voice recording still works.

New conversation titles are generated from the first user prompt through the configured local Ollama model. This is enabled by default and can be disabled without affecting chat responses:

```env
CONVERSATION_TITLE_GENERATION_ENABLED=true
CONVERSATION_TITLE_MODEL=qwen3:30b
CONVERSATION_TITLE_TIMEOUT_MS=120000
CONVERSATION_TITLE_MAX_CHARS=4000
CONVERSATION_TITLE_MAX_LENGTH=80
```

If title generation fails or is disabled, the gateway saves a concise fallback title from the first prompt.

## 10. Install dependencies

From the project root:

```bash
npm ci
npm run db:generate
```

`npm ci` uses the committed `package-lock.json` for repeatable installs.

## 11. Run migrations

Migrations are **not** run automatically by `npm start`. Run them once after extracting an update ZIP and before restarting the production app. The helper script `scripts/update-and-restart.sh` runs this step for git-based deployments, but a manual ZIP deployment should run it explicitly:

```bash
npm run db:generate
npm run db:migrate
```

For a new local development database, use `npm run db:migrate:dev` instead of `npm run db:migrate`. For an existing production database, prefer `npm run db:migrate`, which maps to `prisma migrate deploy`.

The auth security update specifically adds `prisma/migrations/20260524050000_auth_security/migration.sql`. After that migration succeeds, run the seed/bootstrap step in the next section so Eric exists and any legacy users receive authentication state.

The migrations create or extend:

- `users`
- `auth_sessions`
- `conversations`
- `messages`
- `audio_snippets`

Existing conversations and messages are preserved. Existing users receive authentication fields; Eric is promoted to the administrator by bootstrap/seed.

## 12. Seed/bootstrap Eric

```bash
npm run db:seed
```

The bootstrap process ensures an active administrator named `Eric` exists. If Eric is created or lacks a password hash, the password is set from `INITIAL_ADMIN_PASSWORD` and Eric is required to change it on first login. Existing non-Eric users that lack password hashes are assigned `NEW_USER_DEFAULT_PASSWORD`, marked active, and forced to change their password on next login.

## 13. Development mode

Development mode runs the Express backend and Vite frontend together:

```bash
npm run dev
```

Default development URLs:

- Frontend: `http://<gateway-vm-ip>:5173`
- Backend: `http://<gateway-vm-ip>:3000`

Vite proxies `/api` and `/health` to the backend.

## 14. Production build

```bash
npm run build
```

This writes:

- Backend JavaScript to `dist/server`
- Frontend static assets to `dist/client`

Start directly for a quick smoke test:

```bash
NODE_ENV=production npm start
```

Open:

```text
https://<your-domain.example>
```

or, for a temporary internal test without HTTPS:

```text
http://<gateway-vm-ip>:3000
```

Remember that `SESSION_COOKIE_SECURE=true` requires HTTPS. For internal HTTP-only smoke tests, temporarily set `SESSION_COOKIE_SECURE=false`, then restore it before internet exposure.

## 15. Start with PM2

Install PM2 globally:

```bash
sudo npm install -g pm2
```

Start the app:

```bash
pm2 start ecosystem.config.cjs
pm2 status
```

View logs:

```bash
pm2 logs local-ai-gateway
```

Save the PM2 process list:

```bash
pm2 save
```

## 16. Enable startup after reboot

Run:

```bash
pm2 startup systemd
```

PM2 prints a command beginning with `sudo env PATH=...`. Copy and run that exact command.

Then save again:

```bash
pm2 save
```

Test reboot behavior when convenient:

```bash
sudo reboot
```

After the VM comes back:

```bash
pm2 status
curl http://localhost:3000/health
```

## 17. Bash scripts

Scripts are in `scripts/` and use PM2 app name `local-ai-gateway`.

```bash
scripts/start.sh
scripts/stop.sh
scripts/restart.sh
scripts/status.sh
scripts/logs.sh
```

Make them executable if your unzip tool did not preserve executable bits:

```bash
chmod +x scripts/*.sh
```

## 18. Updating the app with `scripts/update-and-restart.sh`

For a git-based deployment, run from the project root:

```bash
scripts/update-and-restart.sh
```

The script performs:

1. Stops the PM2 app if it is running
2. Runs `git pull --ff-only` when the directory is a git repository
3. Installs dependencies with `npm ci`
4. Runs Prisma client generation
5. Runs database migrations
6. Builds the app
7. Starts or restarts PM2
8. Saves the PM2 process list

For ZIP-based deployments, unzip the new package over or beside the old one, copy your `.env`, then run:

```bash
npm ci
npm run db:generate
npm run db:migrate
npm run db:seed
npm run build
scripts/restart.sh
```

## 19. Testing connectivity to local AI services

From the gateway VM:

```bash
curl http://192.168.1.5:8000/health
curl http://192.168.1.5:8000/gpu
curl http://192.168.1.8:8000/health
curl http://192.168.1.8:8000/gpu
```

Ollama generate test:

```bash
curl http://192.168.1.5:11434/api/generate \
  -d '{
    "model": "qwen3:30b",
    "prompt": "Reply with exactly: local-ai-llm ready",
    "stream": false
  }'
```

Voice transcription test:

```bash
curl -X POST \
  -F "file=@/path/to/audio-file.m4a" \
  http://192.168.1.8:8000/transcribe
```

Gateway unauthenticated health test:

```bash
curl http://localhost:3000/health
```

`/api/status`, conversation, transcription, and LLM generation endpoints now require a logged-in session and CSRF token for mutating requests. Use the browser UI for normal validation.

## 20. Security and Internet Exposure

Bear Castle AI now includes a strong first application-level security layer, but it is not a complete internet security boundary by itself. Pair it with HTTPS, firewalling, regular updates, and monitoring.

Before exposing the gateway beyond a trusted LAN:

1. Set strong non-placeholder values for `INITIAL_ADMIN_PASSWORD`, `NEW_USER_DEFAULT_PASSWORD`, and `SESSION_SECRET`.
2. Run `npm run db:migrate` and `npm run db:seed`.
3. Sign in as Eric and immediately change the initial admin password.
4. Use HTTPS through Nginx, Caddy, Traefik, or another reverse proxy.
5. Keep `SESSION_COOKIE_SECURE=true` behind HTTPS.
6. Set `AUTH_TRUST_PROXY=true` when Express is behind a reverse proxy that terminates TLS.
7. Configure `CORS_ALLOWED_ORIGINS` to your HTTPS origin if cross-origin access is needed; avoid wildcard CORS.
8. Restrict firewall access where possible.
9. Do not expose the Ollama LLM VM or voice VM directly to the internet.
10. Keep `local-ai-llm` and `local-ai-voice` private on the LAN or VPN.

Generate secrets with:

```bash
openssl rand -base64 48
```

Authentication behavior:

- The login page displays active users as minimal safe tiles.
- Eric is the default administrator account.
- Only Eric can create users, deactivate/delete users, and reset passwords.
- New users receive `NEW_USER_DEFAULT_PASSWORD` and must change it on first login.
- Passwords are stored as salted scrypt hashes, never plaintext.
- Sessions are opaque random tokens in HTTP-only cookies; only HMAC token hashes are stored in the database.
- Authenticated mutating API requests require the `X-CSRF-Token` token managed by the frontend.
- Three failed login attempts lock the account for a 5-minute cooldown by default.
- Chat, voice transcription, GPU/health, conversations, and admin APIs require authentication.
- Regular users can access only their own conversations and messages.

## 21. Troubleshooting

### App will not start

Check Node version:

```bash
node --version
npm --version
```

Node must be 24 or newer.

Check `.env` exists and has non-placeholder auth values in production:

```bash
ls -la .env
grep -E 'INITIAL_ADMIN_PASSWORD|NEW_USER_DEFAULT_PASSWORD|SESSION_SECRET|SESSION_COOKIE_SECURE' .env
```

Check PM2 logs:

```bash
pm2 logs local-ai-gateway --lines 100
```

### Secure login cookie is not being set

If you access the app over plain HTTP with `SESSION_COOKIE_SECURE=true`, browsers will reject the session cookie. Use HTTPS or temporarily set this for local-only testing:

```env
SESSION_COOKIE_SECURE=false
```

Restore `SESSION_COOKIE_SECURE=true` before internet exposure.

### Prisma cannot connect to PostgreSQL

Confirm PostgreSQL is running:

```bash
systemctl status postgresql --no-pager
```

Test the configured database URL:

```bash
psql "postgresql://local_ai_gateway:change_me@localhost:5432/local_ai_gateway"
```

If you changed the password, update `.env`.

### Migration permission error on schema public

Run:

```bash
sudo -u postgres psql
```

Then:

```sql
\c local_ai_gateway
GRANT ALL ON SCHEMA public TO local_ai_gateway;
ALTER SCHEMA public OWNER TO local_ai_gateway;
\q
```

Then retry:

```bash
npm run db:migrate
```

### Auth seed fails with `AUTH_MIN_PASSWORD_LENGTH: Too small`

Set `AUTH_MIN_PASSWORD_LENGTH=8` in `.env`, or remove the line entirely to use the built-in default. Values smaller than `8` are treated as misconfiguration:

```env
AUTH_MIN_PASSWORD_LENGTH=8
```

Then rerun:

```bash
npm run db:seed
```

### Auth seed fails with `Invalid production authentication configuration`

The seed command needs the production auth secrets because it hashes Eric's initial password and default passwords for legacy users. Open `.env` and replace all placeholder values before retrying:

```bash
grep -E 'INITIAL_ADMIN_PASSWORD|NEW_USER_DEFAULT_PASSWORD|SESSION_SECRET|SESSION_COOKIE_SECURE' .env
openssl rand -base64 48
```

Required values:

```env
INITIAL_ADMIN_PASSWORD=<strong unique Eric bootstrap password>
NEW_USER_DEFAULT_PASSWORD=<strong temporary password for new users>
SESSION_SECRET=<long random value>
```

Then rerun:

```bash
npm run db:seed
```

### Eric does not appear on the login screen

Run the auth bootstrap seed:

```bash
npm run db:seed
```

Also confirm `INITIAL_ADMIN_PASSWORD`, `NEW_USER_DEFAULT_PASSWORD`, and `SESSION_SECRET` are configured and the app is able to reach PostgreSQL.

### LLM appears offline in the UI

From the gateway VM:

```bash
curl http://192.168.1.5:8000/health
curl http://192.168.1.5:11434/api/generate \
  -d '{"model":"qwen3:30b","prompt":"Say ready","stream":false}'
```

Check that the LLM VM firewall allows the gateway VM to reach ports `11434` and `8000`.

### Voice transcription fails

From the gateway VM:

```bash
curl http://192.168.1.8:8000/health
curl -X POST -F "file=@/path/to/audio-file.m4a" http://192.168.1.8:8000/transcribe
```

Check browser microphone permission and the page origin. The web app uses `MediaRecorder` and `navigator.mediaDevices.getUserMedia`, which Chrome exposes only from HTTPS or from `localhost`/loopback local testing. If you open Bear Castle AI by LAN IP or hostname over plain HTTP, Chrome may hide microphone APIs and the app will show: `Microphone recording requires HTTPS or localhost.`

When exposing Bear Castle AI beyond local loopback testing, terminate TLS at Nginx, Caddy, Traefik, or another reverse proxy. Keep `local-ai-llm` and `local-ai-voice` private on the internal network; expose only the gateway through HTTPS. If a reverse proxy sets `Permissions-Policy`, make sure it allows same-origin microphone access, for example `microphone=(self)`, and does not send `microphone=()`.

### Browser records but transcript is empty

Try a longer, clearer snippet. The voice VM uses VAD filtering, so very short or silent recordings may produce an empty transcript.

### Telemetry cards show stale/error but chat still works

This is expected if a monitor endpoint is temporarily unavailable. Chat and transcription use separate service clients and are not blocked by telemetry polling errors.

### Port 3000 is unavailable

Change `PORT` in `.env`, rebuild/restart, and update the reverse-proxy upstream. For HTTPS hosting, keep `HOST=127.0.0.1` and do not open the Node port publicly:

```bash
# Only for trusted LAN testing, not public HTTPS hosting:
# sudo ufw allow <new-port>/tcp
scripts/restart.sh
```

## 22. Environment variables reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `production` | Runtime mode. Production serves the built frontend and enforces production auth configuration validation. |
| `PORT` | `3000` | Gateway HTTP port. |
| `HOST` | `0.0.0.0` | HTTP bind address. Use `127.0.0.1` behind Caddy/Nginx so only the reverse proxy can reach Node. |
| `APP_NAME` | `Bear Castle AI` | Display/runtime app name. |
| `DATABASE_URL` | PostgreSQL local URL | Prisma database connection string. |
| `AUTH_ENABLED` | `true` | Authentication is expected to remain enabled; production refuses `false`. |
| `INITIAL_ADMIN_PASSWORD` | none in production | Initial Eric password used when Eric is created or missing a password hash. Must be at least 8 characters and changed after first login. |
| `NEW_USER_DEFAULT_PASSWORD` | none in production | Temporary password assigned to new/reset users. Must be at least 8 characters; users must change it on next login. |
| `AUTH_MIN_PASSWORD_LENGTH` | `8` | Minimum accepted new password length. |
| `SESSION_SECRET` | none in production | Long random secret used to HMAC session and CSRF tokens before database storage. |
| `SESSION_COOKIE_NAME` | `bear_castle_ai_session` | HTTP-only session cookie name. |
| `SESSION_TTL_HOURS` | `12` | Sliding session lifetime in hours. |
| `SESSION_COOKIE_SECURE` | `true` in production | Adds the Secure cookie flag. Requires HTTPS in browsers. |
| `SESSION_COOKIE_SAME_SITE` | `lax` | Session cookie SameSite value: `lax`, `strict`, or `none`. |
| `AUTH_TRUST_PROXY` | `true` | Enables Express trust proxy when behind TLS-terminating reverse proxy. |
| `AUTH_MAX_FAILED_LOGIN_ATTEMPTS` | `3` | Failed attempts before lockout within the configured window. |
| `AUTH_LOCKOUT_WINDOW_MINUTES` | `5` | Failed-login counting window. |
| `AUTH_LOCKOUT_DURATION_MINUTES` | `5` | Account lockout duration after too many failures. |
| `AUTH_LOGIN_RATE_LIMIT_WINDOW_MS` | `900000` | IP rate-limit window for login attempts. |
| `AUTH_LOGIN_RATE_LIMIT_MAX` | `20` | Max login attempts per IP per window. |
| `CSRF_ENABLED` | `true` | Requires CSRF tokens for authenticated mutating API requests. |
| `CSRF_HEADER_NAME` | `X-CSRF-Token` | Header used by the frontend to submit CSRF tokens. |
| `CHAT_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window for expensive chat/LLM requests. |
| `CHAT_RATE_LIMIT_MAX` | `20` | Max chat/LLM requests per user per window. |
| `TRANSCRIBE_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window for voice transcription uploads. |
| `TRANSCRIBE_RATE_LIMIT_MAX` | `10` | Max transcription uploads per user per window. |
| `ADMIN_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window for admin user-management actions. |
| `ADMIN_RATE_LIMIT_MAX` | `30` | Max admin user-management actions per window. |
| `CORS_ALLOWED_ORIGINS` | empty | Comma-separated allowed browser origins for production CORS. Same-origin deployments do not need CORS. |
| `SECURITY_HEADERS_ENABLED` | `true` | Enables Helmet security headers and a compatible CSP. |
| `LLM_BASE_URL` | `http://192.168.1.5:11434` | Ollama API base URL. |
| `LLM_MONITOR_BASE_URL` | `http://192.168.1.5:8000` | LLM monitor base URL for health/GPU. |
| `LLM_MODEL` | `qwen3:30b` | Default Ollama model. |
| `LLM_TIMEOUT_MS` | `600000` | LLM request timeout. |
| `VOICE_BASE_URL` | `http://192.168.1.8:8000` | Voice/STT API base URL. |
| `VOICE_TIMEOUT_MS` | `300000` | Voice transcription timeout. |
| `TRANSCRIPT_FORMATTING_ENABLED` | `false` | Enable optional local-LLM cleanup for raw voice transcripts. |
| `TRANSCRIPT_FORMATTING_TIMEOUT_MS` | `120000` | Timeout for optional transcript cleanup requests. |
| `TRANSCRIPT_FORMATTING_MODEL` | `LLM_MODEL` | Ollama model used for optional transcript cleanup. |
| `TRANSCRIPT_FORMATTING_MAX_CHARS` | `12000` | Maximum transcript length eligible for optional cleanup. |
| `CONVERSATION_TITLE_GENERATION_ENABLED` | `true` | Enable local-LLM title generation for new or untitled conversations. |
| `CONVERSATION_TITLE_MODEL` | `LLM_MODEL` | Ollama model used for conversation title generation. |
| `CONVERSATION_TITLE_TIMEOUT_MS` | `120000` | Timeout for conversation title generation requests. |
| `CONVERSATION_TITLE_MAX_CHARS` | `4000` | Maximum first-prompt characters sent to the title prompt. |
| `CONVERSATION_TITLE_MAX_LENGTH` | `80` | Maximum stored conversation title length. |
| `HEALTH_POLL_INTERVAL_MS` | `5000` | Backend health polling interval. |
| `GPU_POLL_INTERVAL_MS` | `2000` | Backend GPU polling interval. |
| `TELEMETRY_STALE_AFTER_MS` | `15000` | Mark cached telemetry stale after this age. |
| `CONVERSATION_CONTEXT_MAX_MESSAGES` | `20` | Max recent messages sent in prompt context. |
| `CONVERSATION_CONTEXT_MAX_CHARS` | `24000` | Max approximate prompt context characters. |
| `MAX_AUDIO_UPLOAD_MB` | `50` | Gateway upload limit for browser audio snippets. |
| `STORE_AUDIO_UPLOADS` | `false` | Keep uploaded audio files after transcription when `true`. |
| `UPLOAD_DIR` | `./storage/uploads` | Upload directory or temp holding directory. |
| `LOG_LEVEL` | `info` | Pino log level. |

## Notes for future expansion

The code is intentionally separated into configuration, API routes, Prisma data access, LLM client, voice client, telemetry polling, and React UI components. This leaves clear paths for streaming responses, WebSocket telemetry updates, document/RAG retrieval, richer search, and per-user settings. OAuth, SSO, MFA, and email recovery are intentionally out of scope for this first local-gateway auth hardening pass.
