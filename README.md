# Bear Castle AI local AI gateway

Bear Castle AI is a lightweight browser application for a local AI lab. It runs on a gateway VM and provides a ChatGPT-like UI for two existing local AI service VMs:

- `local-ai-llm` at `192.168.1.5`, running Ollama with `qwen3:30b`
- `local-ai-voice` at `192.168.1.8`, running the local-ai-voice Node gateway with modern `/api` routes for STT, TTS, GPU, health, model catalogs, model load/unload, mutable defaults, and reference audio

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
- Settings modal with admin-only local LLM model loading/default-model selection plus voice VM status, STT/TTS model controls, mutable defaults, reference-audio upload, and reference loading for future TTS
- Server-side session storage with HTTP-only cookies and CSRF protection
- Login lockout and endpoint rate limiting
- Conversation persistence in PostgreSQL
- Previous conversation browsing scoped to the signed-in user
- Local-LLM generated titles for new conversations
- Chat prompt submission to Ollama
- Browser voice snippet recording with MediaRecorder
- Compact Listening UI with live microphone activity, Stop-to-transcribe, and Cancel-to-discard controls
- Audio forwarding to `local-ai-voice /api/stt/transcribe` only when a recording is stopped/accepted
- Transcript append-to-input behavior before sending
- Manual text-to-speech playback for user prompts and assistant responses through `local-ai-voice /api/tts/speak`
- Optional local-LLM transcript punctuation/paragraph cleanup for unformatted STT output
- Markdown-rendered assistant responses
- Cached health/GPU telemetry for both AI VMs after login
- Dedicated mobile chat layout below 768px with hidden conversation history and system health panels opened from mobile controls
- PM2 startup after reboot
- Deployment helper scripts

### Responsive UI layout

Desktop remains the default layout at 768px and wider, preserving the top bar, conversation history column, main chat pane, system health pane, and resizable composer/workspace behavior. Below 768px, the React app switches to a dedicated mobile layout focused on the active conversation: the Bear Castle AI top bar stays visible, mobile controls open conversation history and System Health as overlays, the message list scrolls independently, and the composer stays pinned to the bottom with text entry, microphone recording, Stop/Cancel recording, transcript append, and send controls.

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
  |                   http://192.168.1.5:11434/api/tags
  |                   http://192.168.1.5:11434/api/ps
  |                   http://192.168.1.5:11434/api/show
  |                   http://192.168.1.5:11434/api/pull
  |                   http://192.168.1.5:11434/api/delete
  |                   http://192.168.1.5:8000/health
  |                   http://192.168.1.5:8000/gpus (primary multi-GPU telemetry)
  |                   http://192.168.1.5:8000/gpu (legacy fallback)
  |                   http://192.168.1.5:8000/model/load
  |                   http://192.168.1.5:8000/storage (optional)
  |
  +--> local-ai-voice http://192.168.1.8:8000/api/stt/transcribe
                      http://192.168.1.8:8000/api/tts/speak
                      http://192.168.1.8:8000/api/tts/reference-audio
                      http://192.168.1.8:8000/api/health
                      http://192.168.1.8:8000/api/services
                      http://192.168.1.8:8000/api/gpu
                      http://192.168.1.8:8000/api/models/stt
                      http://192.168.1.8:8000/api/models/tts
                      http://192.168.1.8:8000/api/config
                      http://192.168.1.8:8000/voices (descriptor compatibility route)
```

The backend serves the frontend in production from `dist/client` and exposes APIs under `/api/*`. The unauthenticated public API surface is intentionally small: login users, login, and `/health`. Conversation, status/GPU, settings/model status, voice status/config, transcription, text-to-speech, LLM generation, and user-management APIs require authentication. Model pulls, deletes, LLM loading/default-model changes, voice model load/unload, voice config updates, voice reference uploads/loads/deletions, and voice logs are Eric/admin-only and remain CSRF-protected.

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

These are gateway defaults only. Change the service URLs in `.env` if the VM IPs or ports change. Mutable STT/TTS defaults now live in the local-ai-voice `/api/config` API and can be updated from Settings > Voice when supported by the voice VM.

## True LLM response streaming

Bear Castle AI streams real generated text from Ollama into the conversation UI. The browser posts prompts to the authenticated gateway route `POST /api/conversations/:conversationId/messages/stream`; the browser never calls Ollama or the local-ai-llm monitor directly. The gateway validates the session, CSRF token, rate limit, and conversation ownership, persists the user message, then calls `POST {LLM_BASE_URL}/api/generate` with `stream: true` using the current/default model resolved from local-ai-llm model management.

The gateway returns `application/x-ndjson` to the browser. Events are newline-delimited JSON with these stable shapes:

```json
{"type":"start","conversationId":"...","userMessage":{"id":"..."},"assistantMessageTempId":"...","model":"qwen3:14b","createdAt":"..."}
{"type":"metadata","provider":"ollama","endpoint":"/api/generate","model":"qwen3:14b","generatedAt":"..."}
{"type":"delta","delta":"Hello","content":"Hello","generatedAt":"..."}
{"type":"done","assistantMessage":{"id":"..."},"conversation":{"id":"..."},"titleGeneration":{"needed":true}}
```

Ollama's response is parsed incrementally as NDJSON. The gateway appends only normal `/api/generate` `response` text to the visible assistant message and ignores separate `thinking` fields so hidden reasoning is not shown as assistant content. The browser reads the response with `fetch()` and `ReadableStream.getReader()`, parses NDJSON boundaries safely, and appends each `delta` to the same temporary assistant message. The old local “Thinking…” indicator remains only as a placeholder before the first real delta arrives; completed responses are no longer locally animated to mimic streaming.

The assistant message is persisted only after Ollama sends `done: true`. On success the final `done` event carries the saved assistant message id and updated conversation summary, the UI reconciles the temporary message, and deferred title generation is scheduled after stream completion. If the stream fails, the saved user message remains, the assistant placeholder is marked failed, and partial assistant text is not saved as a successful response. If the browser disconnects or the request is aborted, the gateway aborts the upstream Ollama fetch so generation does not continue unnecessarily.

Example curl shape for an already authenticated session with a valid CSRF token:

```bash
curl -N \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/x-ndjson' \
  -H 'X-CSRF-Token: <token-from-/api/auth/me>' \
  -b '<session-cookie>' \
  -d '{"content":"Write a long explanation of streaming NDJSON."}' \
  http://127.0.0.1:3000/api/conversations/<conversation-id>/messages/stream
```

Keep `LLM_BASE_URL`, `LLM_MONITOR_BASE_URL`, Ollama, and local-ai-llm monitor endpoints private to the gateway network. Do not expose Ollama or local-ai-llm directly to browsers or the public internet.

## Model Manager

The gear button in the top application bar opens Settings. The Models section is now an Ollama Model Manager with four compact tabs:

- **Overview** shows the current Bear Castle AI default model, whether that default is currently loaded, currently running/loaded Ollama models, and storage at a glance.
- **Installed** lists locally installed Ollama models with size, modified date, digest, family, parameter size, quantization, running/default markers, and row actions.
- **Browse / Download** provides a safe manual model-name workflow for pulling models locally.
- **Storage** summarizes installed model footprint, optional local-ai-llm disk capacity/free space, low-space warnings, and large installed models that can be deleted.

The browser still talks only to the Bear Castle AI gateway. The gateway talks to Ollama and the local-ai-llm monitor/control service using the configured internal URLs; those internal URLs are never exposed to the browser.

## Voice VM API Contract

Bear Castle AI now targets the modern local-ai-voice Node gateway contract. The voice VM OpenAPI UI is available on the running voice gateway at `GET /api/docs`. The browser still calls only Bear Castle AI; it never calls the voice VM or worker-only ports directly.

Modern routes used by Bear Castle AI:

- STT transcription: `POST {VOICE_BASE_URL}/api/stt/transcribe` with multipart `file`, optional `model`, `language`, `vad_filter`, `min_silence_duration_ms`, `beam_size`, and `word_timestamps`. Bear Castle AI accepts browser uploads at authenticated `/api/transcribe`, forwards the audio to VoiceVM under multipart field `file`, omits `model` unless the caller explicitly provides one, and normalizes camelCase/snake_case transcript metadata back to a stable camelCase response.
- TTS speech: `POST {VOICE_BASE_URL}/api/tts/speak` with JSON for normal text-only speech or multipart when reference audio is needed. The response is returned to the browser as `audio/wav` with `Cache-Control: no-store`.
- GPU telemetry: `GET {VOICE_BASE_URL}/api/gpu`, normalized from `available`, `checkedAt`, and `devices[]` into the compact System Health panel. Missing power/fan fields are omitted instead of showing `undefined`, `NaN`, or placeholder `N/A` rows.
- Health and workers: `GET {VOICE_BASE_URL}/api/health`, `GET /api/services`, `GET /api/services/stt`, and `GET /api/services/tts`.
- Model catalogs/status: `GET /api/models`, `GET /api/models/stt`, and `GET /api/models/tts`.
- Model management: `POST /api/models/stt/load`, `POST /api/models/stt/unload`, `POST /api/models/tts/load`, and `POST /api/models/tts/unload`.
- Mutable defaults: `GET /api/config`, `PATCH /api/config/stt`, and `PATCH /api/config/tts`.
- Reference audio upload: `POST /api/tts/reference-audio` with a WAV file forwarded by the Bear Castle AI gateway.
- Reference audio deletion: the supplied contract does not document a public delete route. Bear Castle AI can call descriptor-provided delete links from `/voices` when present and otherwise attempts the conservative modern fallback `DELETE /api/tts/reference-audio/:id`; if VoiceVM does not expose either shape, the UI reports deletion as unsupported instead of deleting files by path.

The documented compatibility `GET /voices` route remains in use for voice/reference descriptors because the current contract lists descriptors there and the modern contract does not define a replacement listing route. Other compatibility routes (`/health`, `/gpu`, `/models`, `/speak`, `/transcribe`) are not primary integration targets in Bear Castle AI.

Settings > Voice shows service health, STT/TTS worker status, GPU state, model catalogs, model load/unload controls, mutable default config, normalized voice/reference descriptors, and Bear Castle-managed loaded reference. Mutating voice controls are Eric/admin-only and CSRF-protected. Soft unload is exposed by default; hard unload/restart is intentionally not exposed in the UI because the voice VM contract notes that hard restarts require extra systemd privileges.

### Voice Reference Audio

Settings > Voice can upload WAV reference clips through the Bear Castle AI backend, which then calls the VoiceVM `POST /api/tts/reference-audio` route. The browser never calls VoiceVM directly and never contains the internal voice VM URL. Reference uploads, loading, and deletion are admin-only, CSRF-protected, limited by `MAX_AUDIO_UPLOAD_MB` for uploads, and restricted to WAV MIME types/extensions (`audio/wav`, `audio/x-wav`, `audio/wave`, `audio/vnd.wave`, or `.wav`). Browser WebM/Opus microphone recordings are not relabeled as WAV.

VoiceVM may store uploaded reference WAV files under generated safe filenames. The documented contract does not state that `POST /api/tts/reference-audio` preserves or returns the original upload filename, and `GET /voices` remains the descriptor source of truth. Bear Castle AI now keeps a durable sidecar metadata file at `storage/voice-reference-state.json` so future uploads continue to display the user-recognizable original filename or optional display name even when VoiceVM returns a generated stored filename. Generated/stored filenames remain secondary details such as “stored as reference_20260527_abc123.wav.” The sidecar stores metadata only, not uploaded audio. It is intentionally ignored by Git.

The current documented VoiceVM contract does not expose a public set-active-reference route and documents `PATCH /api/config/tts` only for defaults such as `defaultModel` and `language`. It also documents that `POST /api/tts/speak` accepts a `voice` field. Bear Castle AI therefore implements reference loading app-side: admin users click **Load** on a listed `/voices` descriptor, the loaded descriptor id is persisted in `storage/voice-reference-state.json`, and future gateway `/api/speak` calls include that id as the VoiceVM `/api/tts/speak` `voice` field unless the caller explicitly supplies a different `voice`. If VoiceVM exposes an active/current flag and Bear Castle has no loaded reference yet, that active descriptor is shown as the loaded fallback. If Bear Castle has a loaded reference, it is the source of truth because it is the id sent to VoiceVM for future TTS. The UI shows one loaded reference with the highlighted reference card only; it no longer displays separate Active or Selected badges.

Uploading a WAV reference with an optional display name only adds it to the reference list. Upload does not load the new reference and does not change the currently loaded reference. To use a newly uploaded clip for future TTS, click **Load** next to that clip after upload.

Admins can click **Delete** on non-loaded reference descriptors. Bear Castle AI first uses a delete link advertised by the descriptor (`deleteUrl`, `links.delete.href`, `_links.delete.href`, or similar) when VoiceVM provides one. If no descriptor delete link exists, Bear Castle AI attempts the conservative REST fallback `DELETE /api/tts/reference-audio/:id` and then `DELETE /api/tts/reference-audio` with a JSON body containing the descriptor id/filename. Bear Castle AI never deletes VoiceVM files by filesystem path. The currently loaded reference cannot be deleted; load another reference first. If the current VoiceVM build does not support deletion, Settings displays the unsupported-route error, disables delete controls for that session, and leaves the reference list unchanged. If VoiceVM accepts a delete request but `/voices` still lists the descriptor afterward, Bear Castle AI reports that delete was not confirmed instead of pretending the item was removed. Successful deletion removes matching Bear Castle metadata.

Troubleshooting reference audio:

- Uploaded file appears with an unexpected generated name: Bear Castle displays the saved original filename when it can map the upload response or new `/voices` descriptor to the upload. The generated name is shown only as secondary storage detail.
- Reference list does not refresh: use the Settings > Voice refresh button and confirm VoiceVM `GET /voices` responds.
- Loaded reference does not affect TTS: confirm the loaded descriptor id is accepted by VoiceVM as the `/api/tts/speak` `voice` value and that the TTS worker is loaded.
- Delete reports unsupported: confirm the running VoiceVM build exposes a reference-audio delete route or a descriptor delete link in `GET /voices`; the supplied contract does not require deletion.
- Loaded reference is unknown: this is expected when neither Bear Castle has a loaded reference nor VoiceVM exposes active-reference state in `/voices` or `/api/config`. Once a reference is loaded, Bear Castle sends that descriptor id on future TTS requests.
- Upload rejected because it is not WAV: convert the clip to a real WAV file before uploading. Do not rename WebM/Opus recordings to `.wav`.


Troubleshooting:

- `404` from a modern `/api` route usually means the old voice service is still running. Start the new local-ai-voice Node gateway and confirm `GET /api/docs`.
- Model load failures usually indicate a missing model name, GPU memory pressure, a provider/model mismatch, or worker-side autoload restrictions.
- STT/TTS model mismatch errors mean the request model does not match the currently loaded model unless the worker supports autoloading.
- Missing GPU power/fan fields are expected with the new `/api/gpu` shape; Bear Castle AI handles memory, utilization, and temperature without requiring power or fan data.
- System Health uses `GET {LLM_MONITOR_BASE_URL}/gpus` as the primary local-ai-llm GPU telemetry source and renders one compact pod per returned GPU. The legacy `GET {LLM_MONITOR_BASE_URL}/gpu` endpoint remains as a fallback for older monitor services and is normalized as a one-GPU list. The compact GPU pods show VRAM, Power when available, Fan only when available, Utilization, and Temperature; Free VRAM is retained in details but is no longer shown as a separate main bar.
- Reference audio uploads must be WAV. Browser WebM recordings are not labeled or uploaded as WAV unless converted outside the app. Reference deletion requires a compatible VoiceVM delete route; Bear Castle does not delete VoiceVM files by path.
- CORS is not part of the browser flow because the browser calls Bear Castle AI, and Bear Castle AI calls local-ai-voice over the private network.
- Worker-only private APIs and worker ports must stay private and must not be exposed publicly.

### Local model status and details

Model status comes from gateway backend calls to:

- `GET {LLM_MONITOR_BASE_URL}/health` for the configured local-ai-llm default model, whether the default is loaded, and any loaded-model data reported by the monitor.
- `GET {LLM_BASE_URL}/api/tags` for installed local Ollama models, including model names, sizes, modified dates, digests, and basic metadata.
- `GET {LLM_BASE_URL}/api/ps` for currently running/loaded Ollama models.
- `POST {LLM_BASE_URL}/api/show` when the user opens details for an installed model.

The Installed tab uses `/api/tags` as the source of truth for local model files. Details are loaded on demand through `/api/show` and displayed as summarized fields first: model name, size, modified date, digest, format, family/families, parameter size, quantization, context length, capabilities, and optional collapsed license/template/system/modelfile/raw details.

If one source fails, the model manager shows whatever data is still available and displays a warning. For example, if `/api/ps` fails but `/api/tags` works, installed models still render and running state is shown as partial/unavailable.

### Downloading/pulling models

Eric/admin can download a model from the Browse / Download tab by entering an Ollama model name such as `llama3.1:8b`, `qwen3:14b`, `gemma3:12b`, or `deepseek-r1:32b`. The backend validates the model name, prevents duplicate pulls, and calls:

```http
POST {LLM_BASE_URL}/api/pull
Content-Type: application/json

{
  "model": "qwen3:14b",
  "stream": true
}
```

The gateway streams Ollama pull progress back to the Settings UI as newline-delimited JSON. The UI shows status text, completed/total bytes when Ollama provides them, percentage when available, and a progress bar. When the pull completes, installed models and storage are refreshed. Pulling only downloads the model; it does not automatically load or make the model default.

Before pulling, the UI warns that the model size is unknown unless Ollama/storage data can provide enough context. If local-ai-llm disk free space is available, the confirmation includes the reported free space.

### Deleting local models

Eric/admin can delete installed local models from the Installed or Storage tab. The UI requires confirmation and includes the model name and approximate size from `/api/tags`. It adds stronger warnings when the selected model is the current default or is currently loaded/running. The backend validates the model name, rejects conflicting operations, and calls:

```http
DELETE {LLM_BASE_URL}/api/delete
Content-Type: application/json

{
  "model": "qwen3:14b"
}
```

After deletion, the gateway refreshes installed models, running models, and storage. Bear Castle AI does not delete model files by path, run shell commands, or SSH into local-ai-llm; deletion goes through Ollama.

### Load/Warm and Make Default

Existing model load/default behavior is preserved. The Installed tab exposes **Load** and **Make Default** actions for Eric/admin. Both actions call the local-ai-llm monitor/control service through the gateway:

```http
POST {LLM_MONITOR_BASE_URL}/model/load
Content-Type: application/json

{
  "model": "qwen3:14b",
  "make_default": false
}
```

`make_default: false` warms the model without changing chat defaults. `make_default: true` updates the configured local-ai-llm default, and future Bear Castle AI chat requests use the refreshed default model when local-ai-llm reports it. The gateway still falls back to `LLM_MODEL` only when the monitor default is unavailable.

### External Ollama catalog browsing

The local Ollama API can list installed models and pull known model names, but it is not a remote public model-library search API. This implementation does not scrape Ollama's public HTML pages or make local model management depend on internet access. Browse / Download therefore uses a manual model-name workflow plus a link to the Ollama model library where an admin can copy an exact model/tag.

If Ollama later publishes a stable official model-catalog JSON API, it can be added behind the gateway without changing the browser-to-gateway security model.

### Storage monitoring

Storage is shown in two layers:

1. **Installed model footprint** is always calculated by summing model sizes returned by `GET {LLM_BASE_URL}/api/tags`.
2. **Disk free/total** is shown only when local-ai-llm exposes a monitor storage endpoint. The gateway tries `GET {LLM_MONITOR_BASE_URL}{LLM_STORAGE_ENDPOINT}` and, when `LLM_STORAGE_ENDPOINT=/storage`, also tries `/disk` as a compatibility fallback.

Preferred local-ai-llm storage response shape:

```json
{
  "path": "/usr/share/ollama/.ollama/models",
  "filesystem": "/dev/mapper/ubuntu--vg-ubuntu--lv",
  "used_bytes": 123456789000,
  "available_bytes": 987654321000,
  "total_bytes": 1111111111000,
  "used_percent": 11.1,
  "ollama_models_bytes": 98765432100
}
```

If the storage endpoint is unavailable, Settings shows installed model footprint and a clear "disk data unavailable" note. The gateway does not assume its own VM disk matches local-ai-llm and does not inspect remote disk usage over SSH.

### Authorization and safety

All model manager endpoints require authentication. Mutating endpoints are Eric/admin-only and CSRF-protected:

- `POST /api/settings/models/load`
- `POST /api/settings/models/pull`
- `DELETE /api/settings/models`

Regular authenticated users may view model status when Settings is available, but pull/delete/load/make-default controls are hidden or disabled, and direct API attempts return `403`.

The backend validates model names, contacts only configured `LLM_BASE_URL` and `LLM_MONITOR_BASE_URL`, avoids shell commands, avoids arbitrary URLs, prevents duplicate pulls and conflicting delete/pull operations where practical, and returns clear `409` conflicts for busy model operations.

### Troubleshooting

- **Ollama unavailable:** Installed/running model panels show warnings. Confirm `curl http://192.168.1.5:11434/api/tags` and `curl http://192.168.1.5:11434/api/ps` from the gateway VM.
- **Pull fails:** Check the exact model name/tag, local-ai-llm network access, Ollama logs, and free disk space. A model pull may continue inside Ollama after the browser closes the modal.
- **Not enough disk space:** Delete unused local models from the Storage tab. Full disk free/total requires the local-ai-llm monitor storage endpoint.
- **Delete fails:** Confirm the model name still exists and is not currently involved in another pull/delete operation. If Ollama reports the model is in use, stop using that model and retry.
- **External catalog unavailable:** Manual model-name pull still works because installed/local management does not depend on a public catalog API.
- **Storage endpoint unavailable:** Installed model footprint still works; expose `/storage` or `/disk` from local-ai-llm to show disk capacity/free space.

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

Text-to-speech uses the same `local-ai-voice` base URL. The browser never calls `local-ai-voice` directly; it calls the authenticated Bear Castle AI gateway endpoint, and the gateway posts JSON or multipart form data to `POST /api/tts/speak` on the voice VM. Speech never plays automatically. Users click the speaker icon beside a user prompt or assistant response to generate and play audio.

```env
TTS_ENABLED=true
TTS_TIMEOUT_MS=120000
TTS_MAX_TEXT_CHARS=12000
TTS_RATE_LIMIT_WINDOW_MS=60000
TTS_RATE_LIMIT_MAX=20
```

If `TTS_ENABLED=false`, the gateway rejects text-to-speech requests. `TTS_MAX_TEXT_CHARS` limits expensive requests and should stay reasonable for the voice VM. Legacy `TTS_DEFAULT_VOICE` and `TTS_DEFAULT_SPEED` environment values can remain in existing deployments, but Bear Castle AI now prefers the voice VM `/api/config` defaults and does not need to force a Kokoro-era voice id for ordinary TTS calls.

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
curl http://192.168.1.5:8000/gpus
curl http://192.168.1.5:8000/gpu   # legacy fallback check
curl http://192.168.1.8:8000/api/health
curl http://192.168.1.8:8000/api/gpu
curl http://192.168.1.8:8000/api/services
curl http://192.168.1.8:8000/api/models
curl http://192.168.1.8:8000/api/models/stt
curl http://192.168.1.8:8000/api/models/tts
curl http://192.168.1.8:8000/api/config
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
  -F "vad_filter=true" \
  http://192.168.1.8:8000/api/stt/transcribe
```

Voice text-to-speech test:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello from Bear Castle AI.","language":"en"}' \
  http://192.168.1.8:8000/api/tts/speak \
  --output test.wav
```

Gateway unauthenticated health test:

```bash
curl http://localhost:3000/health
```

`/api/status`, conversation, transcription, text-to-speech, and LLM generation endpoints now require a logged-in session and CSRF token for mutating requests. Use the browser UI for normal validation.

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
- Chat, voice transcription, text-to-speech, GPU/health, conversations, and admin APIs require authentication.
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
curl http://192.168.1.8:8000/api/health
curl -X POST -F "file=@/path/to/audio-file.m4a" http://192.168.1.8:8000/api/stt/transcribe
```

Check browser microphone permission and the page origin. The web app uses `MediaRecorder`, `navigator.mediaDevices.getUserMedia`, and the Web Audio API for the live Listening meter. Chrome exposes microphone capture only from HTTPS or from `localhost`/loopback local testing. If you open Bear Castle AI by LAN IP or hostname over plain HTTP, Chrome may hide microphone APIs and the app will show: `Microphone recording requires HTTPS or localhost.`

In the chat composer, the microphone button starts Listening mode. The live meter responds to microphone input while recording. Choose **Stop** to accept the recording and send it through the authenticated Bear Castle AI `/api/transcribe` gateway endpoint, or choose **Cancel** to discard the captured audio without uploading or transcribing it. The current composer draft remains editable and is not cleared by starting, stopping, or canceling voice capture.

The browser records with the first supported `MediaRecorder` MIME type from the app's preferred list, usually WebM/Opus in Chromium. Bear Castle AI preserves the actual MIME type and uses a matching filename extension such as `.webm`, `.ogg`, `.m4a`, `.mp3`, or `.wav`; it does not relabel WebM/Opus recordings as WAV. If VoiceVM rejects an upload with 400/415/422, the gateway returns that validation error to the UI instead of appending an empty transcript.

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
| `LLM_BASE_URL` | `http://192.168.1.5:11434` | Ollama API base URL used for chat and model management through `/api/tags`, `/api/ps`, `/api/show`, `/api/pull`, and `/api/delete`. |
| `LLM_MONITOR_BASE_URL` | `http://192.168.1.5:8000` | LLM monitor/control base URL for health/GPU, default-model status, and `/model/load`. |
| `LLM_MODEL` | `qwen3:30b` | Gateway fallback/default model at startup. Runtime chat requests prefer the current default reported by local-ai-llm after Settings make-default changes. |
| `LLM_TIMEOUT_MS` | `600000` | LLM request timeout; also used as a fallback for long-running model load/warm requests. |
| `MODEL_DISCOVERY_TIMEOUT_MS` | `30000` | Timeout for model status discovery calls such as Ollama `/api/tags`, `/api/ps`, and optional monitor storage checks. |
| `MODEL_DETAILS_TIMEOUT_MS` | `30000` | Timeout for on-demand Ollama `/api/show` model detail requests. |
| `MODEL_PULL_TIMEOUT_MS` | `3600000` | Timeout for long-running Ollama `/api/pull` downloads. |
| `MODEL_DELETE_TIMEOUT_MS` | `120000` | Timeout for Ollama `/api/delete` requests. |
| `MODEL_MAX_CONCURRENT_PULLS` | `1` | Maximum simultaneous model pulls allowed by the gateway. |
| `LLM_STORAGE_ENDPOINT` | `/storage` | Optional local-ai-llm monitor path for disk free/total. When `/storage`, the gateway also tries `/disk` as a fallback. |
| `STORAGE_LOW_DISK_WARNING_PERCENT` | `85` | Warn in Settings when reported local-ai-llm disk used percent is at or above this value. |
| `STORAGE_LOW_DISK_WARNING_BYTES` | `53687091200` | Warn in Settings when reported local-ai-llm available bytes are at or below this value. |
| `VOICE_BASE_URL` | `http://192.168.1.8:8000` | local-ai-voice Node gateway base URL. Bear Castle AI targets modern `/api` routes under this URL and never calls worker-only ports. |
| `VOICE_TIMEOUT_MS` | `300000` | General voice VM request timeout, including STT transcription and settings reads when a more specific timeout is not used. |
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
