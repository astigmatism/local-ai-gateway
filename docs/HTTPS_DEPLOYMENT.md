# Bear Castle AI HTTPS deployment guide for Ubuntu Server 24.04 LTS

This guide explains how to expose only the Bear Castle AI gateway over HTTPS while keeping the internal AI services private.

These instructions target **Ubuntu Server 24.04 LTS**. If your server was described as Ubuntu 24.02, verify the actual release with `lsb_release -a`; if it reports a different Ubuntu release, verify package names and commands before proceeding.

Recommended public example hostname in this guide: `gateway.msdos.games`.

Equivalent alternate hostname: `gateway.crazyerics.com`.

Use either domain you own, preferably with a subdomain such as:

- `gateway.msdos.games`
- `ai.msdos.games`
- `bear.msdos.games`
- `gateway.crazyerics.com`
- `ai.crazyerics.com`
- `bear.crazyerics.com`

Do not create public DNS records or router port forwards for `local-ai-llm`, `local-ai-voice`, Ollama, the STT service, or internal GPU/health monitor ports.

## 1. Recommended architecture

Use a reverse proxy on the gateway VM:

```text
Internet browser
  |
  | https://gateway.msdos.games
  | TCP 443 public HTTPS
  v
Caddy or Nginx on gateway VM
  - listens on TCP 80 and TCP 443
  - obtains and renews trusted TLS certificates
  - terminates HTTPS
  - proxies to http://127.0.0.1:3000
  v
Bear Castle AI Node/Express app
  - HOST=127.0.0.1
  - PORT=3000
  - not exposed directly to the internet
  |
  | private LAN only
  +--> local-ai-llm   http://192.168.1.5:11434 and http://192.168.1.5:8000
  +--> local-ai-voice http://192.168.1.8:8000
```

Use this design instead of running Node directly on port 443. Node does not need to run as root, the app can stay on `127.0.0.1:3000`, and the reverse proxy handles certificate issuance, TLS, redirects, and HTTP headers.

## 2. Which HTTPS option should I use?

### Recommended: Caddy automatic HTTPS

Use Caddy unless you already have an Nginx standard. Caddy is the simplest path for a self-hosted app with a real domain because it automatically requests and renews trusted certificates when DNS and ports are correct.

Caddy should listen on public ports `80` and `443` and reverse-proxy to `http://127.0.0.1:3000`.

### Alternate: Nginx with Certbot / Let's Encrypt

Use Nginx + Certbot if you prefer a traditional Nginx layout or already manage other Nginx sites on the gateway. Nginx listens on public ports `80` and `443`; Certbot obtains and renews the Let's Encrypt certificate.

### Local/lab only: self-signed certificate

A self-signed certificate encrypts traffic but is not trusted by browsers by default. Chrome and other browsers will show warnings unless you manually trust your private CA/certificate. For an internet-facing Bear Castle AI URL under `msdos.games` or `crazyerics.com`, use Let's Encrypt through Caddy or Certbot instead.

## 3. What HTTPS requires

For a normal public HTTPS URL such as `https://gateway.msdos.games`, you need all of these:

1. A chosen hostname under a domain you own.
2. A public DNS `A` record pointing that hostname to your public IPv4 address.
3. Optionally, a DNS `AAAA` record if the gateway is reachable over public IPv6.
4. TCP port `80` reachable from the internet for HTTP validation and HTTP-to-HTTPS redirect.
5. TCP port `443` reachable from the internet for HTTPS.
6. Caddy or Nginx/Certbot running on the gateway VM.
7. Bear Castle AI running locally on `127.0.0.1:3000` under PM2.
8. Production auth/session settings in `.env` so cookies work through the HTTPS reverse proxy.

## 4. DNS records

Pick one hostname first. The rest of the guide uses `gateway.msdos.games`.

At your DNS provider, create:

```text
Type: A
Name: gateway
Value: <your public IPv4 address>
TTL: automatic/default is fine
```

If you choose `gateway.crazyerics.com` instead:

```text
Type: A
Name: gateway
Value: <your public IPv4 address>
TTL: automatic/default is fine
```

Optional IPv6 record, only if the gateway has a working public IPv6 address and your router/firewall allows inbound IPv6 TCP 80/443:

```text
Type: AAAA
Name: gateway
Value: <your public IPv6 address>
TTL: automatic/default is fine
```

Verify public DNS before requesting a certificate:

```bash
dig gateway.msdos.games
nslookup gateway.msdos.games
```

At least one answer must match the public IP that reaches your gateway network. DNS must resolve publicly before Let's Encrypt HTTP validation can work.

If you use Cloudflare or another proxy/CDN, start with the simple direct-DNS path first: DNS-only/unproxied record, public ports 80/443 forwarded to your gateway VM, then issue the certificate. Cloudflare proxy mode, strict TLS settings, or CDN firewall rules can change certificate issuance behavior. Once direct issuance works, you can decide whether to re-enable the proxy/CDN.

## 5. Router/NAT port forwarding

If the gateway VM is behind a home router or NAT firewall, forward only these ports from the router's public interface to the gateway VM's private IP:

```text
TCP 80  -> gateway VM TCP 80
TCP 443 -> gateway VM TCP 443
```

Do **not** forward:

```text
TCP 3000               Bear Castle AI Node port
TCP 11434              Ollama
TCP 8000 on AI VMs     monitor/STT services
Any local-ai-llm port
Any local-ai-voice port
```

The browser should reach only Caddy/Nginx over HTTPS. Caddy/Nginx then talks to Node locally on the same gateway VM.

## 6. Ubuntu firewall

If UFW is enabled on the gateway VM, allow public web traffic:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw status
```

Keep port `3000` private. The preferred control is app binding:

```env
HOST=127.0.0.1
PORT=3000
```

If you previously opened `3000/tcp`, remove or deny that public rule after confirming the app is bound to localhost:

```bash
sudo ufw delete allow 3000/tcp
# or, if delete cannot find the exact rule:
sudo ufw deny 3000/tcp
sudo ufw status numbered
```

## 7. Bear Castle AI `.env` settings for HTTPS

Use `.env.example` as the base:

```bash
cp .env.example .env
nano .env
```

For HTTPS hosting behind Caddy or Nginx, set these values:

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3000

SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAME_SITE=lax
AUTH_TRUST_PROXY=true
CSRF_ENABLED=true
SECURITY_HEADERS_ENABLED=true

# Same-origin deployment can leave this blank.
CORS_ALLOWED_ORIGINS=

# If you intentionally split frontend and API across origins, use exact HTTPS origins only.
# CORS_ALLOWED_ORIGINS=https://gateway.msdos.games
```

Also replace all authentication placeholders:

```env
INITIAL_ADMIN_PASSWORD=<strong unique Eric bootstrap password>
NEW_USER_DEFAULT_PASSWORD=<strong temporary password for new/reset users>
SESSION_SECRET=<long random value from openssl rand -base64 48>
```

Generate a strong session secret:

```bash
openssl rand -base64 48
```

Keep the internal AI URLs private LAN URLs:

```env
LLM_BASE_URL=http://192.168.1.5:11434
LLM_MONITOR_BASE_URL=http://192.168.1.5:8000
VOICE_BASE_URL=http://192.168.1.8:8000
```

`PUBLIC_APP_URL`, `APP_ORIGIN`, and separate CSRF trusted-origin variables are not currently required by this app. The current CSRF protection uses a server-generated token submitted by the frontend, and the current same-origin production deployment does not require CORS. If you later add strict Origin/Referer validation, add the chosen HTTPS origin such as `https://gateway.msdos.games` to that allowlist.

## 8. PM2 app setup behind the reverse proxy

Install dependencies, run database setup, build, and run under PM2 as before:

```bash
npm ci
npm run db:generate
npm run db:migrate
npm run db:seed
scripts/start.sh
```

After changing `.env`, restart the app so PM2 picks up `HOST=127.0.0.1`, `PORT=3000`, and the auth/session changes:

```bash
scripts/restart.sh
pm2 status
pm2 logs local-ai-gateway --lines 100
```

Confirm the app responds locally before configuring the reverse proxy:

```bash
curl http://127.0.0.1:3000/health
sudo ss -tulpn | grep -E ':(80|443|3000)\b'
```

For the Node process, the `ss` output should show `127.0.0.1:3000` rather than `0.0.0.0:3000` when `HOST=127.0.0.1` is active.

## 9. Approach A: Caddy automatic HTTPS

Use this as the primary path.

### 9.1 Install Caddy

```bash
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
sudo systemctl enable --now caddy
```

### 9.2 Configure Caddy

Copy the example file into place:

```bash
sudo cp deploy/caddy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
```

Default example:

```caddyfile
gateway.msdos.games {
    encode zstd gzip

    request_body {
        max_size 60MB
    }

    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Forwarded-Host {host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

To use `gateway.crazyerics.com`, replace only the site address:

```caddyfile
gateway.crazyerics.com {
    encode zstd gzip

    request_body {
        max_size 60MB
    }

    reverse_proxy 127.0.0.1:3000 {
        header_up Host {host}
        header_up X-Forwarded-Host {host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

The `request_body` limit is set to `60MB` because Bear Castle AI defaults `MAX_AUDIO_UPLOAD_MB=50`. Keep the proxy limit equal to or higher than the app's upload limit, with a little room for multipart overhead.

### 9.3 Validate and reload Caddy

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy -f
```

When DNS and ports are correct, Caddy automatically obtains and renews a trusted certificate for `gateway.msdos.games` or your chosen hostname. It also handles the HTTP-to-HTTPS redirect.

### 9.4 Test Caddy HTTPS

```bash
curl -I http://gateway.msdos.games
curl -I https://gateway.msdos.games
```

Expected result:

- `http://gateway.msdos.games` redirects to HTTPS.
- `https://gateway.msdos.games` returns a normal response from Bear Castle AI.
- Chrome shows a valid lock icon.
- Login, chat, microphone recording, and transcription work after authentication.

## 10. Approach B: Nginx + Certbot / Let's Encrypt

Use this if you prefer traditional Nginx.

The official Certbot instructions currently recommend the snap installation path for most users. Ubuntu APT packages are also common, but the snap path keeps Certbot closer to upstream Certbot releases.

### 10.1 Install Nginx and Certbot using the snap path

```bash
sudo apt update
sudo apt install -y nginx snapd
sudo systemctl enable --now nginx
sudo snap install core
sudo snap refresh core
sudo apt remove -y certbot python3-certbot-nginx || true
sudo snap install --classic certbot
sudo ln -sf /snap/bin/certbot /usr/local/bin/certbot
```

If you intentionally prefer Ubuntu APT packages instead of snap, install them this way:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
```

Use one Certbot installation method, not both.

### 10.2 Configure the initial Nginx site

```bash
sudo cp deploy/nginx/bear-castle-ai.conf.example /etc/nginx/sites-available/bear-castle-ai
sudo nano /etc/nginx/sites-available/bear-castle-ai
sudo ln -sf /etc/nginx/sites-available/bear-castle-ai /etc/nginx/sites-enabled/bear-castle-ai
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Default initial server block:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name gateway.msdos.games;

    client_max_body_size 60M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
        proxy_read_timeout 600s;
    }
}
```

The current Bear Castle AI app does not use WebSockets or server-sent events, so no Upgrade-specific proxy settings are required.

### 10.3 Request the certificate

Make sure DNS resolves and port 80 reaches Nginx before running Certbot:

```bash
dig gateway.msdos.games
curl -I http://gateway.msdos.games
```

Then run:

```bash
sudo certbot --nginx -d gateway.msdos.games
```

For `gateway.crazyerics.com`:

```bash
sudo certbot --nginx -d gateway.crazyerics.com
```

Choose the redirect option when Certbot asks whether to redirect HTTP to HTTPS.

Certbot stores issued certificates and private keys under `/etc/letsencrypt/`. Do not copy those files into the project and do not commit them to git.

### 10.4 Test renewal and HTTPS

```bash
sudo certbot renew --dry-run
sudo nginx -t
sudo systemctl reload nginx
curl -I https://gateway.msdos.games
```

Certbot installs automatic renewal through a systemd timer or cron depending on the installation method. You can inspect timers with:

```bash
systemctl list-timers | grep -i certbot || true
```

## 11. Approach C: self-signed certificate for local/private lab testing only

Use this only for lab testing where browser warnings are acceptable or where you manually trust your own private certificate authority.

Example local certificate generation:

```bash
mkdir -p ~/bear-castle-ai-local-certs
cd ~/bear-castle-ai-local-certs
openssl req -x509 -newkey rsa:4096 \
  -keyout bear-castle-ai.key \
  -out bear-castle-ai.crt \
  -days 365 \
  -nodes \
  -subj "/CN=gateway.local"
chmod 600 bear-castle-ai.key
```

Do not store generated private keys or certificates in the Bear Castle AI source tree. Do not include real private keys in ZIP files. A self-signed certificate can encrypt traffic, but browsers do not trust it by default. For a public URL under `msdos.games` or `crazyerics.com` without browser warnings, use Caddy or Nginx/Certbot with Let's Encrypt.

## 12. Microphone recording and HTTPS

Bear Castle AI uses browser microphone recording through `navigator.mediaDevices.getUserMedia` and `MediaRecorder`. Modern browsers require a secure context for microphone access, except for `localhost`/loopback development.

Practical effect:

- `https://gateway.msdos.games` should allow microphone APIs after the user grants browser permission.
- `http://gateway.msdos.games` may hide microphone APIs or fail recording.
- `http://192.168.x.x:3000` may fail microphone recording in Chrome because LAN IP HTTP is not a secure context.
- A self-signed certificate may still fail or warn until the certificate is trusted by the browser/OS.

The app's security headers intentionally include:

```text
Permissions-Policy: microphone=(self), camera=(), geolocation=()
```

Do not override this with `microphone=()` in Caddy, Nginx, Cloudflare, or another proxy.

Microphone troubleshooting checklist:

1. Open the HTTPS URL, not an old HTTP URL.
2. Confirm Chrome shows a valid lock icon and no certificate warning.
3. Click the browser site-settings icon and allow microphone access for the hostname.
4. Confirm the page is not inside an iframe that blocks microphone permission.
5. Check DevTools Console for `navigator.mediaDevices` or `getUserMedia` errors.
6. Confirm reverse proxy headers are not replacing `Permissions-Policy` with a stricter value.
7. Confirm `SECURITY_HEADERS_ENABLED=true` in `.env` so the app sends compatible headers.

## 13. Validation checklist after deployment

Run these from the gateway VM unless noted:

```bash
# DNS
dig gateway.msdos.games
nslookup gateway.msdos.games

# Process health
pm2 status
pm2 logs local-ai-gateway --lines 100
curl http://127.0.0.1:3000/health
sudo ss -tulpn | grep -E ':(80|443|3000)\b'

# Reverse proxy health
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy --lines 100 --no-pager

# Or, for Nginx/Certbot
sudo nginx -t
sudo systemctl status nginx --no-pager
sudo certbot renew --dry-run

# Public checks
curl -I http://gateway.msdos.games
curl -I https://gateway.msdos.games
```

Then test in Chrome:

1. Visit `https://gateway.msdos.games`.
2. Confirm the lock icon is valid.
3. Log in as Eric.
4. Change the bootstrap password if prompted.
5. Send a text chat message.
6. Start and stop microphone recording.
7. Submit a transcription.
8. Confirm chat, voice transcription, GPU/health, conversations, and admin routes still require authentication.
9. Confirm `local-ai-llm` and `local-ai-voice` are not reachable from the public internet.
10. Confirm `http://gateway.msdos.games` redirects to HTTPS.

You can also run the helper script:

```bash
scripts/verify-https-prereqs.sh gateway.msdos.games
```

## 14. Troubleshooting: certificate will not issue

Common causes:

- DNS does not point to the public IP that reaches the gateway network.
- DNS has not propagated yet.
- TCP port 80 is blocked by the router, cloud firewall, ISP, or UFW.
- Router/NAT is not forwarding TCP 80 to the gateway VM.
- Another service is already using port 80.
- Caddy/Nginx is not running.
- Cloudflare or another proxy/CDN is interfering with HTTP validation.
- You are trying to issue a certificate for the apex/root domain while DNS points only a subdomain, or the reverse case.

Useful commands:

```bash
dig gateway.msdos.games
curl -I http://gateway.msdos.games
sudo ufw status
sudo ss -tulpn | grep -E ':80|:443'
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy --lines 200 --no-pager
sudo systemctl status nginx --no-pager
sudo nginx -t
```

For Caddy, review:

```bash
sudo journalctl -u caddy -f
```

For Nginx/Certbot, retry after fixing DNS/port 80:

```bash
sudo certbot --nginx -d gateway.msdos.games
```

## 15. Troubleshooting: app unavailable through HTTPS

Check the local app first:

```bash
pm2 status
pm2 logs local-ai-gateway --lines 100
curl http://127.0.0.1:3000/health
```

Check that the app is listening where the reverse proxy expects it:

```bash
grep -E '^(HOST|PORT)=' .env
sudo ss -tulpn | grep ':3000'
```

Expected `.env` behind the reverse proxy:

```env
HOST=127.0.0.1
PORT=3000
```

If Node is listening on a different port, update the Caddyfile or Nginx `proxy_pass`, or change `.env` back to `PORT=3000` and restart PM2.

## 16. Troubleshooting: HTTPS works but login loops or cookies are missing

Common causes:

- `SESSION_COOKIE_SECURE=false` while expecting production HTTPS security.
- `SESSION_COOKIE_SECURE=true` but the browser is actually using HTTP.
- `AUTH_TRUST_PROXY=false` or reverse proxy is not sending `X-Forwarded-Proto: https`.
- Browser has stale cookies from earlier HTTP testing.
- You are switching between `gateway.msdos.games`, LAN IP, and localhost, which creates different cookie origins.
- Future Origin/Referer validation, if added later, does not include the exact HTTPS origin.

Recommended `.env`:

```env
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAME_SITE=lax
AUTH_TRUST_PROXY=true
CSRF_ENABLED=true
```

Fix sequence:

```bash
grep -E 'SESSION_COOKIE_SECURE|SESSION_COOKIE_SAME_SITE|AUTH_TRUST_PROXY|CSRF_ENABLED' .env
scripts/restart.sh
pm2 logs local-ai-gateway --lines 100
```

Then clear cookies for the hostname in Chrome and log in again at the HTTPS URL.

## 17. Troubleshooting: microphone fails over HTTPS

Common causes:

- The page is not actually loaded over HTTPS.
- The certificate is invalid, expired, self-signed, or not trusted.
- Browser microphone permission is blocked for the hostname.
- A proxy/CDN header overrides `Permissions-Policy` and blocks microphone access.
- The browser is still on an old `http://` URL.
- The app is loaded in an iframe without microphone permission.

Commands and checks:

```bash
curl -I https://gateway.msdos.games | grep -i permissions-policy
curl -I https://gateway.msdos.games | grep -i strict-transport-security
```

In Chrome, open DevTools Console and check whether `navigator.mediaDevices` exists. If it is undefined, the page is not a secure context or browser policy is blocking it.

## 18. Troubleshooting: voice transcription upload fails

Common causes:

- Gateway cannot reach `local-ai-voice` on the private LAN.
- The proxy body-size limit is smaller than the recording upload.
- The voice VM times out on long audio.
- The user is not authenticated or the CSRF token is missing/stale.
- `MAX_AUDIO_UPLOAD_MB` is lower than the recording size.

Checks from the gateway VM:

```bash
curl http://192.168.1.8:8000/health
curl -X POST -F "file=@/path/to/audio-file.m4a" http://192.168.1.8:8000/transcribe
pm2 logs local-ai-gateway --lines 100
grep MAX_AUDIO_UPLOAD_MB .env
```

For Caddy, keep `request_body max_size` at or above the app upload limit plus multipart overhead. For Nginx, keep `client_max_body_size` at or above that value.

## 19. Troubleshooting: LLM or telemetry fails after HTTPS setup

HTTPS setup should not change internal private-service URLs. From the gateway VM:

```bash
curl http://192.168.1.5:8000/health
curl http://192.168.1.8:8000/health
curl http://192.168.1.5:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3:30b","prompt":"Say ready","stream":false}'
```

If these fail, fix private LAN routing/firewall between the gateway VM and the AI VMs. Do not expose those services to the internet as a workaround.

## 20. Security checklist before internet exposure

Before opening ports on your router/firewall:

1. Confirm HTTPS works with a trusted certificate.
2. Confirm `HOST=127.0.0.1` and `PORT=3000` in `.env`.
3. Confirm only Caddy/Nginx listens publicly on 80/443.
4. Confirm port 3000 is not public.
5. Confirm `SESSION_SECRET` is long and random.
6. Confirm `INITIAL_ADMIN_PASSWORD` and `NEW_USER_DEFAULT_PASSWORD` are not placeholders.
7. Confirm Eric's bootstrap password is changed after first login.
8. Confirm `SESSION_COOKIE_SECURE=true`.
9. Confirm `AUTH_TRUST_PROXY=true`.
10. Keep `CSRF_ENABLED=true`.
11. Keep `SECURITY_HEADERS_ENABLED=true`.
12. Keep failed-login cooldown/rate limits enabled.
13. Keep `local-ai-llm`, `local-ai-voice`, Ollama, STT, and monitor endpoints private.
14. Keep Ubuntu packages updated:

    ```bash
    sudo apt update
    sudo apt upgrade
    ```

15. Optionally add fail2ban or reverse-proxy rate limiting if the app is exposed to repeated unwanted traffic.

HTTPS and these controls reduce risk, but they do not make an internet-facing local AI gateway perfectly secure. Keep backups, monitor logs, and expose only what is necessary.

## 21. Manual follow-up summary

Use this as the final deployment checklist:

1. Choose hostname, for example `gateway.msdos.games` or `gateway.crazyerics.com`.
2. Create a DNS `A` record pointing that hostname to your public IPv4 address.
3. Optionally create a DNS `AAAA` record only if IPv6 is available and allowed.
4. If behind a router/NAT, forward TCP `80` and `443` to the gateway VM only.
5. Open Ubuntu firewall ports `80/tcp` and `443/tcp`.
6. Do not forward or publicly expose the gateway Node port `3000`.
7. Do not forward or publicly expose Ollama, STT, monitor, `local-ai-llm`, or `local-ai-voice` ports.
8. Configure `.env` with `HOST=127.0.0.1`, `PORT=3000`, `SESSION_COOKIE_SECURE=true`, and `AUTH_TRUST_PROXY=true`.
9. Replace all auth placeholders and generate a strong `SESSION_SECRET`.
10. Restart PM2 with `scripts/restart.sh`.
11. Confirm `curl http://127.0.0.1:3000/health` works locally.
12. Install and configure Caddy, or install Nginx and run Certbot.
13. Visit `https://gateway.msdos.games` in Chrome.
14. Confirm the browser lock icon.
15. Confirm `http://gateway.msdos.games` redirects to HTTPS.
16. Log in.
17. Test chat.
18. Test microphone recording.
19. Test transcription.
20. Check PM2 and reverse-proxy logs after testing.
