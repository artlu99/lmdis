# lmdis

Lightweight HTTP key-value store backed by LMDB. Redis-compatible command API over HTTP, built with Bun.

## Quick start

```bash
bun install

# Generate a token and save it (Bun auto-loads .env)
echo "LMDIS_REST_TOKEN=$(openssl rand -hex 32)" >> .env

bun start
```

```bash
# Set a value
curl -X POST localhost:3000 \
  -H "Authorization: Bearer $LMDIS_REST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '["SET", "hello", "world"]'

# Get a value
curl -X POST localhost:3000 \
  -H "Authorization: Bearer $LMDIS_REST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '["GET", "hello"]'
```

Interactive API docs at [localhost:3000/docs](http://localhost:3000/docs) (no auth required).

## SDK

Copy [`src/sdk.ts`](src/sdk.ts) into your project (~130 lines, zero runtime dependencies). It mirrors the [Upstash Redis](https://upstash.com/docs/redis/features/restapi) client API over lmdis HTTP.

```ts
import { LmdisClient } from "./lmdis/sdk"; // path to your copy

const redis = new LmdisClient({
  url: process.env.LMDIS_URL ?? "http://localhost:3000",
  token: process.env.LMDIS_REST_TOKEN!,
});

await redis.set("hello", "world");
const value = await redis.get<string>("hello");
```

There is no npm package — vendor the file or import it from a checked-out clone. Self-host the server from this repo (`bun start`).

Runnable example (server must be up with `LMDIS_REST_TOKEN` in `.env`):

```bash
bun examples/client.ts
```

## Authentication

lmdis uses a single bearer token, similar to [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi) auth.


|                           |                                                    |
| ------------------------- | -------------------------------------------------- |
| **Header**                | `Authorization: Bearer <token>`                    |
| **Env var**               | `LMDIS_REST_TOKEN` (required at startup)           |
| **Missing/invalid token** | `401` with `{"error":"...","code":"UNAUTHORIZED"}` |


**Protected routes** — all data commands (`POST /`) and `GET /uptime`.

**Public routes** — `GET /health` (load balancer probes), `GET /docs`, `GET /openapi.json`, and `GET /` (redirects to `/docs`).

Generate a token:

```bash
openssl rand -hex 32
```

Example `.env`:

```bash
PORT=3000
LMDIS_REST_TOKEN=a1b2c3d4e5f6...   # from openssl rand -hex 32
```

The server exits on startup if `LMDIS_REST_TOKEN` is not set.

## Commands

All examples below require `-H "Authorization: Bearer $LMDIS_REST_TOKEN"` unless noted.

### Strings


| Command | POST body                 | Returns                                   |
| ------- | ------------------------- | ----------------------------------------- |
| `SET`   | `["SET", "key", "value"]` | `{"result":"OK"}`                         |
| `GET`   | `["GET", "key"]`          | `{"result":"value"}` or `{"result":null}` |
| `DEL`   | `["DEL", "key"]`          | `{"result":1}` or `{"result":0}`          |

Optional TTL on `SET` (same as [Upstash Redis REST](https://upstash.com/docs/redis/features/restapi)):

| Option | POST body example | Meaning |
| ------ | ----------------- | ------- |
| `EX` | `["SET", "key", "value", "EX", 60]` | Expire in 60 seconds |
| `PX` | `["SET", "key", "value", "PX", 5000]` | Expire in 5000 ms |
| `EXAT` | `["SET", "key", "value", "EXAT", 1718123456]` | Expire at Unix time (seconds) |
| `PXAT` | `["SET", "key", "value", "PXAT", 1718123456789]` | Expire at Unix time (ms) |
| `KEEPTTL` | `["SET", "key", "value", "KEEPTTL"]` | Update value, keep existing TTL |

A plain `SET` without TTL clears any previous expiration on that key. Expired keys return `null` on `GET` (lazy deletion).

`DEL` removes the string value (if any) and all hash fields and set members stored under that key.

### Hashes


| Command | POST body                        | Returns               |
| ------- | -------------------------------- | --------------------- |
| `HINCR` | `["HINCR", "key", "field", "1"]` | `{"result":<number>}` |


Atomically increments a hash field by the given amount.

### Sets


| Command | POST body                   | Returns                          |
| ------- | --------------------------- | -------------------------------- |
| `SADD`  | `["SADD", "key", "member"]` | `{"result":1}` or `{"result":0}` |
| `SMEMB` | `["SMEMB", "key"]`          | `{"result":["a","b"]}`           |
| `SDEL`  | `["SDEL", "key", "member"]` | `{"result":1}` or `{"result":0}` |


### Server


| Endpoint            | Auth   | Returns                 |
| ------------------- | ------ | ----------------------- |
| `GET /health`       | none   | `{"status":"ok"}`       |
| `GET /uptime`       | bearer | `{"uptimeSeconds":123}` |
| `GET /openapi.json` | none   | OpenAPI 3.1 spec        |
| `GET /docs`         | none   | Interactive API docs    |


Health check (no auth):

```bash
curl localhost:3000/health
```

## Limitations

- No transactions or batch operations (MULTI/EXEC)
- Single bearer token for authentication — no multi-user or RBAC support
- No keyspace enumeration (KEYS command removed due to O(n) full-table scan)
- Request body size capped at 1MB (`413` when `Content-Length` exceeds the limit)
- No CORS — lmdis is intended for server-to-server use. Browser clients should call your own backend, which proxies requests to lmdis using `LMDIS_REST_TOKEN` server-side.
- `/uptime` resets on `bun run dev` (`--watch`) hot-reload — dev-mode limitation only; production processes keep accurate uptime until restart

## Browser clients

lmdis does not set CORS headers. Cross-origin browser JavaScript cannot call lmdis directly — and should not, because exposing `LMDIS_REST_TOKEN` in frontend code leaks full database access.

Instead, add a same-origin endpoint on your backend that forwards commands:

```ts
// your-backend/routes/kv.ts — same-origin to your frontend
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

Server-to-server clients (`curl`, Bun/Node backends, workers) are unaffected — CORS is enforced only by browsers.

## Configuration


| Variable           | Default      | Description                                              |
| ------------------ | ------------ | -------------------------------------------------------- |
| `PORT`             | `3000`       | HTTP listen port                                         |
| `LMDIS_REST_TOKEN` | *(required)* | Bearer token for all routes except `/health`             |
| `LMDIS_RATE_LIMIT` | *(disabled)* | Max requests per client IP per minute; `0` or unset = no limit |
| `LMDIS_ACCESS_LOG` | `0`          | Set to `1` to log `METHOD path status duration` per request |

When `LMDIS_RATE_LIMIT` is set, lmdis tracks requests per client IP (from `X-Forwarded-For` or `X-Real-IP` when behind a proxy). All routes count toward the limit, including `GET /health`. Exceeded requests return `429` with `{"error":"rate limit exceeded","code":"RATE_LIMITED"}`.

Bun auto-loads `.env` files.

## Tech stack

- [Bun](https://bun.sh) — runtime and HTTP server
- [LMDB](https://github.com/Venemo/node-lmdb) — embedded key-value storage
- [Zod](https://zod.dev) — request validation and OpenAPI schema generation

## Deployment

See [DEPLOY.md](./DEPLOY.md) for production setup, Docker, systemd, and security notes.

## Development

```bash
bun install
bun run dev      # --watch mode (set LMDIS_REST_TOKEN in .env first)
bun test         # auto-discovers tests/
bunx tsc --noEmit # typecheck
```

`bun run dev` reloads the process on file changes, which resets `/uptime` to zero. Use `bun start` when you need a stable uptime counter during local testing.

