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
| `LMDIS_SWEEP_INTERVAL_MS` | `0` (off) | no | Background TTL sweep interval; `> 0` enables        |
| `LMDIS_SWEEP_BATCH`  | `500`          | no       | Expiry records examined per background sweep batch   |

Never commit `LMDIS_REST_TOKEN`. Store via secret manager / `EnvironmentFile` / `--env-file`, not baked into images.

## Authentication (deployment-relevant)

- Header: `Authorization: Bearer <token>`.
- Protected: `POST /`, `POST /admin/sweep-expired`, `GET /uptime`, `GET /metrics`. Public: `GET /health`, `GET /ready`, `GET /docs`, `GET /openapi.json`, `GET /`.
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

## pm2

pm2 >= 6 runs Bun apps through its fork container (`ProcessContainerForkBun.js`), which **imports** the app as a module rather than executing it. `import.meta.main` is then `false` and `src/index.ts`'s guarded startup block never runs — the process sits "online" with empty logs and no listener. Start `serve.ts`, which calls `main()` unconditionally:

```bash
pm2 start serve.ts --name lmdis --interpreter ~/.bun/bin/bun
```

pm2 captures the invoking shell's cwd as the app's cwd — always `pm2 start` from the repo root, so Bun finds `.env` and `data/lmdb` resolves. Verify with `pm2 describe lmdis | grep "exec cwd"`.

- Fork mode only; do not use `-i` / cluster mode (Bun does not support it).
- Persist across reboots: `pm2 save` then run the command printed by `pm2 startup`.
- pm2 < 6 executes custom-interpreter scripts directly, so `src/index.ts` also works there — but prefer `serve.ts`, which works on both.

## Docker

Dockerfile:

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production
COPY src/ ./src/
# Run as an unprivileged system user: LMDB writes through native C bindings,
# so the KV process should never run as root. Port 3000 is unprivileged and
# /app/data is the only writable path needed.
RUN groupadd --system lmdis \
  && useradd --system --no-create-home --gid lmdis lmdis \
  && mkdir -p /app/data \
  && chown lmdis:lmdis /app /app/data
USER lmdis
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "const r = await fetch('http://localhost:3000/health'); process.exit(r.ok ? 0 : 1)" || exit 1
CMD ["bun", "run", "src/index.ts"]
```

The container runs as the unprivileged `lmdis` user (no root). The monitoring
compose stack additionally sets `no-new-privileges` and drops all Linux
capabilities. Named volumes pick up `/app/data` ownership from the image
automatically; if you mount a **host directory** instead, `chown` it to the
container's uid on the host first, or startup will fail with an LMDB
permission error.

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

- `GET /health` → `{"status":"ok"}` (no auth) — **liveness**: process is up. Does not verify LMDB.
- `GET /ready` → `{"status":"ready"}` or `503 {"status":"not ready"}` (no auth) — **readiness**: LMDB is reachable.
- Use `/health` for container/LB liveness probes; use `/ready` when traffic should wait for the store.

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

Protected endpoints require `Authorization: Bearer $LMDIS_REST_TOKEN`.

### TTL sweep (optional)

For workloads with many short-lived string keys that are never read again, enable proactive expiry:

```bash
# one-shot batch (repeat until cursor is "0")
curl -X POST http://localhost:3000/admin/sweep-expired \
  -H "Authorization: Bearer $LMDIS_REST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"cursor":"0","limit":1000}'

# or enable background sweeper
export LMDIS_SWEEP_INTERVAL_MS=30000
export LMDIS_SWEEP_BATCH=500
```

`POST /admin/sweep-expired` is auth-protected and excluded from rate limiting. Monitor `lmdis_expired_keys_removed_total` and `lmdis_lmdb_disk_bytes`.

## Monitoring (Prometheus / Grafana)

lmdis exposes Prometheus metrics at `GET /metrics` (Bearer-protected, excluded from rate limiting).

### Scrape target

```yaml
scrape_configs:
  - job_name: lmdis
    static_configs:
      - targets: ["localhost:3000"]
    metrics_path: /metrics
    bearer_token_file: /path/to/lmdis-token   # file containing LMDIS_REST_TOKEN
```

Key metrics:

| Metric | Type | Description |
| ------ | ---- | ----------- |
| `http_requests_total` | counter | HTTP requests by method, route, status |
| `http_request_duration_seconds` | histogram | Request latency by method, route |
| `lmdis_commands_total` | counter | KV commands by type and status |
| `lmdis_command_errors_total` | counter | Command errors by type and code |
| `lmdis_rate_limit_rejected_total` | counter | Rate-limited requests |
| `lmdis_ready` | gauge | 1 when LMDB is ready |
| `lmdis_keys_total` | gauge | Logical key count (cached, 30s) |
| `lmdis_expired_keys_removed_total` | counter | Expired string keys removed (lazy + sweep) |
| `lmdis_sweep_errors_total` | counter | Background sweep batches that failed |
| `lmdis_lmdb_disk_bytes` | gauge | LMDB data directory size |
| `process_resident_memory_bytes` | gauge | Process RSS |

`/metrics` requires the bearer token, so it is safe to expose behind a proxy; binding it to an internal network in production is still recommended — it exposes operational data (request rates, key counts, memory). The compose stack passes the token to Prometheus automatically (`bearer_token_file` written from `LMDIS_REST_TOKEN` at startup).

### Reference stack

A docker-compose stack with lmdis, Prometheus, and Grafana lives in [`deploy/`](./deploy/):

```bash
export LMDIS_REST_TOKEN=$(openssl rand -hex 32)
docker compose -f deploy/docker-compose.monitoring.yml up --build
```

| Service | URL |
| ------- | --- |
| lmdis | http://localhost:3000 |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3001 (admin / `GRAFANA_ADMIN_PASSWORD` or default `admin`) |

Prometheus alert rules: [`deploy/prometheus/alerts.yml`](./deploy/prometheus/alerts.yml). Pre-built dashboard: [`deploy/grafana/dashboards/lmdis.json`](./deploy/grafana/dashboards/lmdis.json).

## Rate limiting (operational notes)

`LMDIS_RATE_LIMIT=N` enables a per-IP fixed 60 s window (`N` requests/min/IP). IP resolution: first `X-Forwarded-For` entry → else `X-Real-IP` → else `"unknown"`. Most routes count toward the limit; `/metrics`, `/ready`, and `/admin/sweep-expired` are excluded so Prometheus scrapes and admin sweeps are not throttled. Over-limit → `429 {"error":"rate limit exceeded","code":"RATE_LIMITED"}`. In-memory, single-instance only.

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
