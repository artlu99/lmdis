# lmdis

HTTP key-value store over LMDB. Redis-like command API sent as JSON arrays over `POST /`. Runtime: Bun + TypeScript (no build step).

## Quick start

```bash
bun install
```

```bash
echo "LMDIS_REST_TOKEN=$(openssl rand -hex 32)" >> .env
```

```bash
# bun run src/index.ts ;  bun dev == --watch
bun start          
```

```bash
# set
curl -X POST localhost:3000 -H "Authorization: Bearer $LMDIS_REST_TOKEN" \
  -H "Content-Type: application/json" -d '["SET","hello","world"]'
```

```bash
# get
curl -X POST localhost:3000 -H "Authorization: Bearer $LMDIS_REST_TOKEN" \
  -H "Content-Type: application/json" -d '["GET","hello"]'
```

### SDK

Copy `src/sdk.ts` (~130 lines, zero deps) into your project. Mirrors the Upstash Redis REST client surface. Not on npm — vendor it or import from a checked-out clone.

```ts
import { LmdisClient } from "./sdk"; // your vendored path

const redis = new LmdisClient({
  url: process.env.LMDIS_URL ?? "http://localhost:3000",
  token: process.env.LMDIS_REST_TOKEN!,
});

await redis.set("hello", "world");
const value = await redis.get<string>("hello");
```

## Details

- Transport: HTTP/JSON. Single endpoint for all data ops: `POST /`.
- Storage: LMDB (memory-mapped, embedded, persistent).
- Validation: Zod v4 + zod-openapi (OpenAPI 3.1 at `/openapi.json`).
- Distribution: self-host from source or compiled binary. No npm package. SDK is vendored (`src/sdk.ts`).

Deployment, process management, TLS, Docker: see [DEPLOY.md](./DEPLOY.md).

## SDK (vendored)

Serialization: `set` serializes values — strings as-is, number/boolean via `String()`, other types via `JSON.stringify`. `get` deserializes via `JSON.parse`, falling back to the raw string on parse failure. `sadd`/`srem` members: strings as-is, numbers via `String()`.

Constructor: `new LmdisClient({ url, token, fetch? })`. Optional `fetch` override (defaults to global `fetch`). Throws `LmdisError` on non-2xx response or when `result` is absent.


| Method                              | Wire command(s)                                | Returns              | Notes                                                                                                             |
| ----------------------------------- | ---------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `set<T>(key, value, opts?)`         | `["SET",key,val,(EX|PX|EXAT|PXAT|KEEPTTL)?]`   | `"OK"`               | `opts`: `ex`/`px`/`exat`/`pxat`/`keepTtl` (mutually exclusive). `get`/`nx`/`xx` throw `LmdisError` (unsupported). |
| `get<T>(key)`                       | `["GET",key]`                                  | `T | null`           | JSON-deserialized                                                                                                 |
| `del(...keys)`                      | `["DEL",key]` × N                              | `number`             | One request per key; sums removed counts                                                                          |
| `hincrby(key, field, increment)`    | `["HINCR",key,field,String(increment)]`        | `number`             |                                                                                                                   |
| `sadd(key, ...members)`             | `["SADD",key,member]` × N                      | `number`             | One request per member; sums new-added counts                                                                     |
| `smembers(key)`                     | `["SMEMB",key]`                                | `string[]`           |                                                                                                                   |
| `srem(key, ...members)`             | `["SDEL",key,member]` × N                      | `number`             | One request per member; sums removed counts                                                                       |
| `keys(pattern?)`                    | `["KEYS"]` or `["KEYS",pattern]`               | `string[]`           |                                                                                                                   |
| `scanKeys(cursor, count, pattern?)` | `["SCANKEYS",cursor,count,("MATCH",pattern)?]` | `[string, string[]]` |                                                                                                                   |


Runnable example (server must be running with `LMDIS_REST_TOKEN` in `.env`):

```bash
bun examples/client.ts
```

## HTTP API


| Method | Path            | Auth   | Response body                                    |
| ------ | --------------- | ------ | ------------------------------------------------ |
| POST   | `/`             | bearer | Command result (see Commands)                    |
| GET    | `/`             | none   | `302` redirect → `/docs`                         |
| GET    | `/health`       | none   | `{"status":"ok"}`                                |
| GET    | `/ready`        | none   | `{"status":"ready"}` or `503 {"status":"not ready"}` |
| GET    | `/metrics`      | bearer | Prometheus text exposition format (see Monitoring) |
| GET    | `/uptime`       | bearer | `{"uptimeSeconds":<int>}`                        |
| POST   | `/admin/sweep-expired` | bearer | `{"cursor":"<next>","removed":<int>}` (see Admin: TTL sweep) |
| GET    | `/openapi.json` | none   | OpenAPI 3.1 document                             |
| GET    | `/docs`         | none   | HTML (Scalar API reference from `/openapi.json`) |


## Authentication


| Item             | Value                                                               |
| ---------------- | ------------------------------------------------------------------- |
| Header           | `Authorization: Bearer <token>`                                     |
| Required env     | `LMDIS_REST_TOKEN` (server exits if unset)                          |
| Protected routes | `POST /`, `GET /uptime`, `POST /admin/sweep-expired`, `GET /metrics` |
| Public routes    | `GET /health`, `GET /ready`, `GET /docs`, `GET /openapi.json`, `GET /` |
| Comparison       | `timingSafeEqual` (constant-time)                                   |
| Missing token    | `401 {"error":"Missing authorization token","code":"UNAUTHORIZED"}` |
| Invalid token    | `401 {"error":"Invalid authorization token","code":"UNAUTHORIZED"}` |


Generate a token: `openssl rand -hex 32`.

## Commands

All commands are `POST /` with `Content-Type: application/json` body = a JSON array. All require the bearer header. Response is always a JSON object with either `result` (success) or `error`+`code` (failure).

### Strings


| CMD   | Request body      | Success response                      |
| ----- | ----------------- | ------------------------------------- |
| `SET` | `["SET","k","v"]` | `{"result":"OK"}`                     |
| `GET` | `["GET","k"]`     | `{"result":"v"}` or `{"result":null}` |
| `DEL` | `["DEL","k"]`     | `{"result":1}` or `{"result":0}`      |


`SET` TTL options (append after value; mutually exclusive):


| Option    | Request body                           | Semantics                        |
| --------- | -------------------------------------- | -------------------------------- |
| `EX`      | `["SET","k","v","EX",60]`              | expire in 60 seconds             |
| `PX`      | `["SET","k","v","PX",5000]`            | expire in 5000 ms                |
| `EXAT`    | `["SET","k","v","EXAT",1718123456]`    | expire at Unix time (seconds)    |
| `PXAT`    | `["SET","k","v","PXAT",1718123456789]` | expire at Unix time (ms)         |
| `KEEPTTL` | `["SET","k","v","KEEPTTL"]`            | replace value, keep existing TTL |


- Plain `SET` (no TTL option) **clears** any existing expiry on the key.
- TTL values must be positive integers (number or numeric string).
- Expired keys: `GET` returns `null` (lazy expiry on access). Keys with TTL that are never read again remain on disk until swept — see **Admin: TTL sweep** below.
- `DEL` removes the string value, its TTL entry, **all** hash fields, **all** set members, and the key index entry. Returns `1` if anything existed, else `0`.

### Admin: TTL sweep

Proactive expiry for string keys with TTL metadata. Not part of the Redis-like command API.

```http
POST /admin/sweep-expired
Authorization: Bearer <token>
Content-Type: application/json

{"cursor": "0", "limit": 500}
```

Response: `{"cursor":"<nextCursor>","removed":42}`. `cursor === "0"` means the pass is complete. `limit` defaults to `500`, max `1000`. Requires auth; excluded from rate limiting.

For TTL-heavy workloads (many write-once keys), run in a loop or set `LMDIS_SWEEP_INTERVAL_MS` (see environment variables). Does not shrink the LMDB file on disk — only removes logically dead keys.

### Hashes


| CMD     | Request body                | Success response      |
| ------- | --------------------------- | --------------------- |
| `HINCR` | `["HINCR","k","field","1"]` | `{"result":<number>}` |


- `amount` is a string of a finite number (positive, negative, or fractional). Field initializes at `0` if absent.

### Sets


| CMD     | Request body            | Success response                                         |
| ------- | ----------------------- | -------------------------------------------------------- |
| `SADD`  | `["SADD","k","member"]` | `{"result":1}` (new) or `{"result":0}` (already present) |
| `SMEMB` | `["SMEMB","k"]`         | `{"result":["a","b"]}`                                   |
| `SDEL`  | `["SDEL","k","member"]` | `{"result":1}` (removed) or `{"result":0}` (absent)      |


### Key enumeration


| CMD        | Request body                                                       | Success response                     |
| ---------- | ------------------------------------------------------------------ | ------------------------------------ |
| `KEYS`     | `["KEYS"]` or `["KEYS","pattern"]`                                 | `{"result":["k1","k2"]}`             |
| `SCANKEYS` | `["SCANKEYS","0",100]` or `["SCANKEYS","0",100,"MATCH","pattern"]` | `{"result":["<nextCursor>",["k1"]]}` |


- Both iterate a dedicated logical-key index: `O(k)` over user keys, not over hash/set rows.
- `MATCH` pattern: Redis-style glob — `*` (any seq), `?` (one char), `[abc]` / `[a-z]` (class), `\` (escape). Patterns ending in `literal`* with no other metachars use an indexed prefix range scan.
- `SCANKEYS`: `cursor` is a string (`"0"` = start; returned non-`"0"` cursor = more results). `count` ≤ `1000`. Returns `[nextCursor, keys]`; `nextCursor === "0"` means iteration complete.
- `KEYS` returns the full matching list in one response — prefer `SCANKEYS` on large keyspaces.

## Errors


| HTTP | Body                                                                     | Trigger                          |
| ---- | ------------------------------------------------------------------------ | -------------------------------- |
| 400  | `{"error":"invalid JSON",...}` *(code `VALIDATION_ERROR`)*               | malformed request JSON           |
| 400  | `{"error":<zod message>,...}` *(code `VALIDATION_ERROR`)*                | request failed schema validation |
| 401  | `{"error":"...","code":"UNAUTHORIZED"}`                                  | missing/invalid bearer token     |
| 413  | `{"error":"request body too large (max 1MB)","code":"VALIDATION_ERROR"}` | `Content-Length` > 1,000,000     |
| 429  | `{"error":"rate limit exceeded","code":"RATE_LIMITED"}`                  | rate limit exceeded              |
| 500  | `{"error":<message>,"code":"INTERNAL_ERROR"}`                            | uncaught handler error           |


All error bodies share the shape `{"error":string,"code":string}`. All success bodies share `{"result":<value>}`.

## Constraints

- Request body: max 1 MB (`Content-Length` enforced, `413`).
- `SCANKEYS` count: max `1000`.
- Keys/fields/members: non-empty strings, must not contain `\x00` (used as internal LMDB delimiter).
- `SET` TTL options are mutually exclusive.
- No transactions / batch / pipelining at the protocol level (one command per request).
- No CORS headers. Server-to-server only; browser clients must go through a same-origin backend proxy that holds the token.
- `GET /uptime` resets on `bun run dev` (`--watch`) hot-reload (dev-only; production keeps accurate uptime until restart).
- Keys ≥ ~61 characters: `ordered-binary` switches to a raw UTF-8 encoding for strings ≥ 64 bytes, so internal index/expiry entries for long keys sort in a different byte region than short ones and can be missed by `KEYS`/`SCANKEYS`/`DEL`/sweep range scans. Short and multibyte keys are unaffected. Known limitation — tracked for a storage-format migration.

## Environment variables

Bun auto-loads `.env`.


| Variable           | Default      | Meaning                                                              |
| ------------------ | ------------ | -------------------------------------------------------------------- |
| `LMDIS_REST_TOKEN` | *(required)* | Bearer token. Server exits if unset.                                 |
| `PORT`             | `3000`       | HTTP listen port                                                     |
| `LMDIS_RATE_LIMIT` | *(disabled)* | Max requests/IP/minute. `0` or unset = off. Must be `> 0` to enable. |
| `LMDIS_ACCESS_LOG` | `0`          | `1` = log `METHOD path status <ms>` per request to stdout            |
| `LMDB_PATH`        | `data/lmdb`  | LMDB data file path (relative to working directory)                  |
| `LMDIS_SWEEP_INTERVAL_MS` | `0` (off) | Background TTL sweep interval in ms; `> 0` enables              |
| `LMDIS_SWEEP_BATCH` | `500`       | Expiry records examined per background sweep batch                   |


### Rate limiting

When `LMDIS_RATE_LIMIT > 0`: per-IP fixed window of 60 s. Client IP = first entry of `X-Forwarded-For`, else `X-Real-IP`, else literal `"unknown"`. All routes count except `GET /metrics`, `GET /ready`, and `POST /admin/sweep-expired` (kept throttle-free so Prometheus scrapes and admin sweeps are never limited). Over-limit requests return `429` `{"error":"rate limit exceeded","code":"RATE_LIMITED"}`. In-memory, single-instance only — use a reverse proxy for multi-instance / stricter limits.

## Monitoring

`GET /metrics` exposes Prometheus metrics (Bearer-protected, excluded from rate limiting; values refresh on scrape). Prometheus authenticates via `bearer_token_file` — see [DEPLOY.md](DEPLOY.md).

| Metric | Type | Meaning |
| ------ | ---- | ------- |
| `lmdis_expired_keys_removed_total` | counter | Expired string keys removed (lazy expiry + TTL sweep) |
| `lmdis_sweep_errors_total` | counter | Background sweep batches that failed |
| `lmdis_keys_total` | gauge | Logical keys in the store index (cached 30 s) |
| `lmdis_lmdb_disk_bytes` | gauge | On-disk size of the LMDB data directory |
| `lmdis_commands_total` / `lmdis_command_errors_total` | counters | KV commands executed / errors, by type |
| `lmdis_rate_limit_rejected_total` | counter | Requests rejected by rate limiting |
| `http_requests_total` / `http_request_duration_seconds` | counter / histogram | HTTP traffic and latency by route |
| `process_resident_memory_bytes` / `lmdis_uptime_seconds` / `lmdis_ready` | gauges | Process RSS, uptime, readiness (1/0) |

Eviction status: watch `rate(lmdis_expired_keys_removed_total[5m])`. A ready-made Prometheus + Grafana stack (scrape config, alert rules, provisioned dashboard) is in [`deploy/`](deploy) — see [DEPLOY.md](DEPLOY.md). `/metrics` requires the bearer token and exposes operational data — still keep it off the public internet where possible.

## Development

```bash
bun install
bun run dev        # src/index.ts with --watch
bun test           # auto-discovers tests/
bunx tsc --noEmit  # typecheck (no script defined)
```

