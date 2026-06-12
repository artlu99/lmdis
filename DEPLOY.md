# Deploying lmdis

## Prerequisites

- [Bun](https://bun.sh) >= 1.0 on the target machine
- A strong random token for `LMDIS_REST_TOKEN`

## Authentication

Every request must include a bearer token **except** `GET /health`.

| | |
|---|---|
| **Header** | `Authorization: Bearer <token>` |
| **Env var** | `LMDIS_REST_TOKEN` (required — server refuses to start without it) |
| **Public probe** | `GET /health` — no auth, for load balancers and monitoring |

Generate a token:

```bash
openssl rand -hex 32
```

Store it in `.env` or your platform's secret manager — never commit it to git.

Example `.env`:

```bash
PORT=3000
LMDIS_REST_TOKEN=your-64-char-hex-token-here
```

Bun auto-loads `.env` files — no dotenv dependency needed.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `LMDIS_REST_TOKEN` | *(required)* | Bearer token for all routes except `/health` |
| `LMDIS_RATE_LIMIT` | *(disabled)* | Max requests per client IP per minute (`0` = off) |
| `LMDIS_ACCESS_LOG` | `0` | Set to `1` for one-line access logs to stdout |

## Graceful shutdown

lmdis handles `SIGTERM` and `SIGINT` by stopping the HTTP server and calling `store.close()` before exit. Docker and systemd send `SIGTERM` on stop — no extra configuration needed.

## Production run

```bash
bun install --production

# Set token once (persist in .env or export in your shell profile)
export LMDIS_REST_TOKEN=$(openssl rand -hex 32)
echo "LMDIS_REST_TOKEN=$LMDIS_REST_TOKEN" >> .env

bun run index.ts
```

No build step required — Bun runs TypeScript directly.

Verify:

```bash
curl http://localhost:3000/health                              # no auth
curl -H "Authorization: Bearer $LMDIS_REST_TOKEN" \
  -X POST localhost:3000 -H "Content-Type: application/json" \
  -d '["SET", "ping", "pong"]'
```

## Standalone binary

Compile a single self-contained binary with no runtime dependency:

```bash
bun build --compile index.ts --outfile lmdis

export LMDIS_REST_TOKEN=$(openssl rand -hex 32)
./lmdis
```

The binary embeds Bun and all dependencies. `PORT` and `LMDIS_REST_TOKEN` env vars still work.

## Data persistence

LMDB data is stored at `data/lmdb` relative to the working directory. This directory must:

- Exist or be writable (LMDB creates it on first run)
- Live on a **persistent volume** — not tmpfs or ephemeral storage
- Have sufficient disk for your dataset (LMDB uses memory-mapped files)

To use a custom path, set the `LMDB_PATH` env var or pass it when constructing the store (requires code change).

## Systemd

Use `EnvironmentFile` to keep the token out of the unit file:

```ini
[Unit]
Description=lmdis KV store
After=network.target

[Service]
Type=simple
User=lmdis
WorkingDirectory=/opt/lmdis
EnvironmentFile=/opt/lmdis/.env
ExecStart=/usr/local/bin/bun run index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Create `/opt/lmdis/.env` owned by the `lmdis` user:

```bash
PORT=3000
LMDIS_REST_TOKEN=<output of openssl rand -hex 32>
```

```bash
sudo systemctl enable lmdis
sudo systemctl start lmdis
```

Health check (no auth header):

```bash
curl http://localhost:3000/health
```

## Docker

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY *.ts ./
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["bun", "run", "index.ts"]
```

Run with the token passed as a secret (not baked into the image):

```bash
docker build -t lmdis .
docker run -d -p 3000:3000 \
  -e LMDIS_REST_TOKEN=$(openssl rand -hex 32) \
  -v lmdis-data:/app/data \
  lmdis
```

Or use Docker secrets / `--env-file`:

```bash
echo "LMDIS_REST_TOKEN=$(openssl rand -hex 32)" > lmdis.env
docker run -d -p 3000:3000 --env-file lmdis.env -v lmdis-data:/app/data lmdis
```

The built-in `HEALTHCHECK` hits `/health` without a bearer token.

## Browser / frontend access

lmdis has no CORS headers and is not designed for direct browser access. Use a backend proxy:

- **Do not expose** `LMDIS_REST_TOKEN` to client-side JavaScript.
- **Bind lmdis privately** — localhost or an internal network — when co-located with your proxy.
- **Do not publish** lmdis directly to the public internet for browser-driven apps. Route traffic through your application backend, which holds the bearer token server-side.

See [README.md — Browser clients](./README.md#browser-clients) for a minimal proxy example.

## Reverse proxy

Terminate TLS in front of lmdis (nginx, Caddy, Cloudflare, etc.). Bearer tokens must travel over HTTPS in production.

Example nginx location block — proxy all traffic; clients send the bearer header through:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Host $host;
}
```

Configure your load balancer health check to `GET /health` on port 3000 — no auth required.

## Health check

`GET /health` returns `{"status":"ok"}` — use this for load balancer probes and container health checks. No bearer token required.

```bash
curl http://localhost:3000/health
```

All other endpoints require:

```bash
Authorization: Bearer $LMDIS_REST_TOKEN
```

## Rate limiting

Set `LMDIS_RATE_LIMIT` to cap requests per client IP per minute (uses `X-Forwarded-For` or `X-Real-IP` when behind a proxy). Exceeded requests return `429` with `{"error":"rate limit exceeded","code":"RATE_LIMITED"}`.

```bash
LMDIS_RATE_LIMIT=600   # 600 requests/minute per IP
```

This is a basic in-memory limiter — sufficient for single-instance deployments. Use your reverse proxy's rate limiting for multi-instance or stricter policies.

## Security

- **Never commit** `LMDIS_REST_TOKEN` — `.env` is gitignored; use secret stores in CI/CD
- **Separate tokens** per environment (dev, staging, prod)
- **Rotation** — change the env var and restart; there is no session store to revoke
- **HTTPS only** in production — bearer tokens in plain HTTP are trivially sniffable
- **Do not log** `Authorization` headers in proxies or application logs
- **Do not expose** the token in client-side code — call lmdis from backend services only
