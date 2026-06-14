# Deploying lmdis

Production deployment reference. Runtime: Bun (>= 1.0), no build step (Bun runs TypeScript directly). API/auth/command details: see [README.md](./README.md).

## Prerequisites

- Bun >= 1.0 on the host.
- A strong random token for `LMDIS_REST_TOKEN` (`openssl rand -hex 32`).
- A persistent disk location for LMDB data (`data/lmdb` by default).

## Environment variables

Bun auto-loads `.env`.

| Variable             | Default        | Required | Meaning                                              |
| -------------------- | -------------- | -------- | ---------------------------------------------------- |
| `LMDIS_REST_TOKEN`   | *(none)*       | **yes**  | Bearer token. Server exits if unset/empty.           |
| `PORT`               | `3000`         | no       | HTTP listen port                                     |
| `LMDIS_RATE_LIMIT`   | *(disabled)*   | no       | Max requests/IP/minute. `> 0` enables; `0`/unset = off. |
| `LMDIS_ACCESS_LOG`   | `0`            | no       | `1` = per-request `METHOD path status <ms>` to stdout |
| `LMDB_PATH`          | `data/lmdb`    | no       | LMDB data path (relative to working directory)       |

Never commit `LMDIS_REST_TOKEN`. Store via secret manager / `EnvironmentFile` / `--env-file`, not baked into images.

## Authentication (deployment-relevant)

- Header: `Authorization: Bearer <token>`.
- Protected: `POST /`, `GET /uptime`. Public: `GET /health`, `GET /docs`, `GET /openapi.json`, `GET /`.
- Load-balancer / container health checks use `GET /health` — no token.
- Comparison is constant-time (`timingSafeEqual`). Rotation = change env var + restart (no session store to revoke).

## Production run (from source)

```bash
bun install --production
export LMDIS_REST_TOKEN=$(openssl rand -hex 32)
echo "LMDIS_REST_TOKEN=$LMDIS_REST_TOKEN" >> .env
bun run src/index.ts
```

Verify:

```bash
curl http://localhost:3000/health                                            # no auth
curl -H "Authorization: Bearer $LMDIS_REST_TOKEN" -X POST localhost:3000 \
  -H "Content-Type: application/json" -d '["SET","ping","pong"]'
```

## Standalone binary (compiled)

Single self-contained executable embedding Bun + all deps. No runtime install needed.

```bash
bun build --compile src/index.ts --outfile lmdis
export LMDIS_REST_TOKEN=$(openssl rand -hex 32)
./lmdis
```

`PORT` / `LMDIS_REST_TOKEN` / all env vars still apply.

## Data persistence

LMDB data lives at `$LMDB_PATH` (default `data/lmdb`, relative to working directory).

Requirements:
- Directory must exist or be creatable (LMDB creates it on first run).
- Must be on a **persistent volume** — not tmpfs / ephemeral container storage.
- Must have headroom for the dataset (LMDB memory-maps its file).

Override path: set `LMDB_PATH` env var, or pass a path to `createStore(path)` in code.

## Graceful shutdown

`SIGTERM` and `SIGINT` → stop HTTP server + `store.close()` + `exit(0)`. Docker `stop` and systemd send `SIGTERM` — no extra config needed.

## Systemd

```ini
[Unit]
Description=lmdis KV store
After=network.target

[Service]
Type=simple
User=lmdis
WorkingDirectory=/opt/lmdis
EnvironmentFile=/opt/lmdis/.env
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/opt/lmdis/.env` (owned by `lmdis` user, mode restrictive):

```bash
PORT=3000
LMDIS_REST_TOKEN=<openssl rand -hex 32>
```

```bash
sudo systemctl enable --now lmdis
curl http://localhost:3000/health
```

## Docker

Dockerfile:

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY src/ ./src/
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["bun", "run", "src/index.ts"]
```

Run — token passed at runtime (not baked in), data on a named volume:

```bash
docker build -t lmdis .
docker run -d -p 3000:3000 \
  -e LMDIS_REST_TOKEN=$(openssl rand -hex 32) \
  -v lmdis-data:/app/data \
  lmdis
```

Or via `--env-file` / Docker secrets:

```bash
echo "LMDIS_REST_TOKEN=$(openssl rand -hex 32)" > lmdis.env
docker run -d -p 3000:3000 --env-file lmdis.env -v lmdis-data:/app/data lmdis
```

Built-in `HEALTHCHECK` hits `GET /health` (no token).

## Reverse proxy (TLS termination)

Terminate TLS in front of lmdis (nginx / Caddy / Cloudflare). Bearer tokens must travel over HTTPS in production. Clients send the bearer header through unchanged.

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Host $host;
}
```

- Bind lmdis privately (localhost / internal network) when co-located with the proxy.
- Configure LB health check to `GET /health` on port 3000 (no auth).
- Do **not** log `Authorization` headers in proxy/app logs.
- For multi-instance or stricter policies, enforce rate limiting at the proxy; lmdis's limiter is single-instance in-memory.

## Health checks

- `GET /health` → `{"status":"ok"}` (no auth) — use for LB probes, container health, uptime monitors.
- All other endpoints require `Authorization: Bearer $LMDIS_REST_TOKEN`.

```bash
curl http://localhost:3000/health
```

## Rate limiting (operational notes)

`LMDIS_RATE_LIMIT=N` enables a per-IP fixed 60 s window (`N` requests/min/IP). IP resolution: first `X-Forwarded-For` entry → else `X-Real-IP` → else `"unknown"`. All routes count (including `/health`). Over-limit → `429 {"error":"rate limit exceeded","code":"RATE_LIMITED"}`. In-memory, single-instance only.

```bash
LMDIS_RATE_LIMIT=600   # 600 requests/min per IP
```

## Browser / frontend access

No CORS headers. Not designed for direct browser access — do **not** expose `LMDIS_REST_TOKEN` in client-side code (it grants full DB access). Route browser traffic through a same-origin backend endpoint that holds the token server-side:

```ts
// your-backend/routes/kv.ts (same-origin to your frontend)
if (req.method === "POST") {
  const body = await req.json();
  const res = await fetch(process.env.LMDIS_URL!, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.LMDIS_REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return Response.json(await res.json(), { status: res.status });
}
```

Server-to-server clients (`curl`, Bun/Node backends, workers) are unaffected — CORS is browser-enforced only.

## Security checklist

- [ ] `LMDIS_REST_TOKEN` generated via `openssl rand -hex 32`; stored in secret manager / `EnvironmentFile` / `--env-file`, never committed.
- [ ] Separate tokens per environment (dev / staging / prod).
- [ ] HTTPS/TLS terminated at the reverse proxy in production (bearer tokens are sniffable over plain HTTP).
- [ ] lmdis bound to a private interface (localhost / internal network), not exposed directly to the internet for browser-driven apps.
- [ ] `Authorization` headers not logged by proxies or application logs.
- [ ] Token never embedded in client-side/frontend code — backend proxy only.
- [ ] LMDB data on a persistent volume.
- [ ] Rotation runbook: change env var + restart (no session store to revoke).
