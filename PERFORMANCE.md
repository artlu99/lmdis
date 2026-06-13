# Performance

This document describes how to measure lmdis throughput and latency, summarizes a reference run on this repository, and compares those numbers to published benchmarks for **Upstash Redis**, **local Redis**, and **Cloudflare Workers KV**.

> **Important:** These systems target different deployment models. lmdis is a self-hosted HTTP KV store backed by LMDB on a single node. Local Redis speaks the Redis protocol in-process over TCP. Upstash and Cloudflare KV are managed, globally distributed HTTP/edge services. Treat cross-system numbers as directional context, not a controlled apples-to-apples shootout.

## Running the benchmark

The benchmark lives in [`benchmark/`](./benchmark/). Each run is **idempotent**:

- All keys are prefixed with `bench:<runId>:` so runs do not collide.
- String values are written with a TTL (default **120 s**, configurable **60–300 s**) so the store auto-prunes if a run exits early.
- Hash and set keys (which do not support TTL) are explicitly deleted at the end of each run.

### Embedded mode (recommended for local measurement)

Spins up an isolated lmdis instance on a random port and a fresh LMDB directory under `data/` (already gitignored):

```sh
BENCHMARK_EMBEDDED=1 bun run benchmark
```

### Against a running server

```sh
# terminal 1
LMDIS_REST_TOKEN=your-token bun start

# terminal 2
LMDIS_REST_TOKEN=your-token bun run benchmark
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BENCHMARK_EMBEDDED` | off | Set to `1` to start an embedded server |
| `BENCHMARK_ITERATIONS` | `500` | Samples per scenario (10–50,000) |
| `BENCHMARK_WARMUP` | `50` | Warmup GETs before the hot-key read test |
| `BENCHMARK_TTL_SEC` | `120` | TTL on benchmark string keys (60–300) |
| `BENCHMARK_VALUE_SIZE` | `256` | Payload size in bytes for SET/GET tests |
| `LMDIS_URL` | `http://127.0.0.1:3000` | Target URL (external mode) |
| `LMDIS_REST_TOKEN` | *(required)* | Bearer token (external mode) |

JSON results are written to `benchmark/results/<runId>.json`.

### Scenarios

| Scenario | What it measures |
|----------|------------------|
| SET (string, with TTL) | Sequential writes over HTTP + LMDB persistence |
| GET (hot key) | Repeated reads of one warmed key |
| Mixed 50/50 SET/GET | 32-key working set, alternating writes and reads |
| HINCR | Hash field increment |
| SADD + SMEMB | Set add followed by members listing (two HTTP round-trips) |

Each sample times one client round-trip (HTTP request → JSON parse → handler → response). There is no pipelining or batch API.

---

## Reference lmdis results

Measured on the development machine used for this repository (embedded mode, 500 iterations, 256-byte values, 120 s TTL):

| Scenario | Throughput | p50 | p95 | p99 |
|----------|------------|-----|-----|-----|
| SET (with TTL) | ~305 ops/s | 2.8 ms | 7.1 ms | 9.4 ms |
| GET (hot key) | ~3,600 ops/s | 0.20 ms | 0.62 ms | 1.5 ms |
| Mixed SET/GET | ~841 ops/s | 1.1 ms | 2.8 ms | 3.8 ms |
| HINCR | ~543 ops/s | 1.7 ms | 3.1 ms | 3.7 ms |
| SADD + SMEMB | ~389 ops/s | 2.4 ms | 4.4 ms | 8.1 ms |

**Takeaways for lmdis:**

- **Reads dominate writes** — LMDB memory-maps data; GET avoids the TTL write path on hot keys.
- **HTTP overhead is visible** — every command is a full HTTP POST with JSON body and response, similar in shape to Upstash’s REST API but without geographic replication.
- **Complex types cost more** — `SADD` + `SMEMB` issues two sequential HTTP calls (SDK limitation) and scans set members on read.

Re-run `BENCHMARK_EMBEDDED=1 bun run benchmark` on your hardware for numbers that match your deployment.

---

## Comparison with other KV stores

### At a glance

| Store | Transport | Typical deployment | Consistency | Best for |
|-------|-----------|-------------------|-------------|----------|
| **lmdis** | HTTP JSON REST | Self-hosted, single node | Strong (local LMDB) | Low-ops embedded KV, Bun/edge backends via proxy |
| **Local Redis** | Redis RESP (TCP) | Co-located process/container | Strong (single instance) | Maximum ops/sec, rich Redis feature set |
| **Upstash Redis** | HTTP REST or RESP | Managed, multi-region | Eventual (global) | Serverless/edge with Redis semantics |
| **Cloudflare KV** | Workers binding / HTTP | Managed, edge-cached | Eventual | Read-heavy config, static-ish data at the edge |

### Single-operation latency (published benchmarks)

These figures come from third-party measurements. Region, payload size, and client setup differ across sources — use them to understand **order-of-magnitude**, not to rank products definitively.

#### Local Redis (`redis-benchmark`, same host)

Arm’s learning-path benchmark on a Google Axion C4A VM with 50 concurrent clients and 100k requests per operation ([Arm Learning Paths — Benchmark Redis](https://learn.arm.com/learning-paths/servers-and-cloud-computing/redis-data-searching/benchmarking/)):

| Operation | Throughput | Avg latency | p50 | p99 |
|-----------|------------|-------------|-----|-----|
| SET | ~150k ops/s | 0.17 ms | 0.17 ms | 0.19 ms |
| GET | ~150k ops/s | 0.17 ms | 0.17 ms | 0.19 ms |

Native Redis over loopback avoids HTTP and JSON serialization entirely. Expect **roughly 10–50× higher throughput** than HTTP-based clients for simple key/value work when Redis is co-located.

The ioredis README notes that pipelining can improve throughput by **50–300%** for batched commands ([redis/ioredis — Benchmarks](https://github.com/redis/ioredis?tab=readme-ov-file#benchmarks)).

#### Upstash Redis (HTTP REST from Cloudflare Worker, IAD)

Upstash compared their global Redis to Cloudflare KV from the same Worker in Washington DC ([Upstash Blog — Upstash Redis vs Cloudflare KV, 2026](https://upstash.com/blog/upstash-redis-vs-cloudflare-kv)):

| Scenario | Upstash p50 | Upstash p99 |
|----------|-------------|-------------|
| Cold read | 6.8 ms | 28.2 ms |
| Single write | 6.2 ms | 8.6 ms |
| Read-after-write | 24.8 ms | 37.0 ms |

Upstash documentation reports **sub-millisecond read latency** when client and database share the same AWS region ([Upstash — Global Replication](https://upstash.com/docs/common/concepts/global-replication)).

For global read traffic across many regions, Deno’s multi-database benchmark (10k samples) measured Upstash Redis at **19 ms p50 / 139 ms p99** read latency ([Deno — Comparing Deno KV](https://deno.com/blog/comparing-deno-kv)).

#### Cloudflare Workers KV

| Source | Scenario | p50 / typical | p99 / tail |
|--------|----------|---------------|------------|
| [Upstash vs KV (IAD Worker)](https://upstash.com/blog/upstash-redis-vs-cloudflare-kv) | Hot read (cached) | 2.6 ms | 5.8 ms |
| [Upstash vs KV (IAD Worker)](https://upstash.com/blog/upstash-redis-vs-cloudflare-kv) | Cold read | 30.6 ms | 45.6 ms |
| [Upstash vs KV (IAD Worker)](https://upstash.com/blog/upstash-redis-vs-cloudflare-kv) | Single write | 171.8 ms | 253.2 ms |
| [Cloudflare changelog (Aug 2025)](https://developers.cloudflare.com/changelog/post/2025-08-22-kv-performance-improvements/) | Global read (p95/p99) | ~50 ms p95 | ~250 ms p99 |
| [Cloudflare engineering blog](https://blog.cloudflare.com/workers-kv-low-latency/) | Hot read (in-memory cache) | < 1 ms | — |
| [Zhen Wang — KV characteristics](https://zmxv.medium.com/performance-characteristics-of-cloudflare-workers-kv-ef44ed7990b9) | `put` / miss read | ~200 ms | high variance on `list` |

KV is optimized for **cached, read-heavy** workloads. Writes and read-after-write paths are substantially slower than Upstash or co-located Redis because of eventual consistency and edge propagation.

### Rough positioning vs lmdis (reference run)

| Workload | lmdis (embedded) | Local Redis¹ | Upstash REST² | Cloudflare KV³ |
|----------|------------------|--------------|---------------|----------------|
| Hot GET | ~0.2 ms p50 | ~0.17 ms p50 | ~2.6–6.8 ms p50 | ~2.6 ms p50 (cached) |
| SET / write | ~2.8 ms p50 | ~0.17 ms p50 | ~6.2 ms p50 | ~172 ms p50 |
| Throughput (GET) | ~3.6k ops/s | ~150k ops/s | varies by region | varies; cache-dependent |

¹ [Arm redis-benchmark](https://learn.arm.com/learning-paths/servers-and-cloud-computing/redis-data-searching/benchmarking/) — same-machine TCP, 50 concurrent clients.

² [Upstash vs KV blog](https://upstash.com/blog/upstash-redis-vs-cloudflare-kv) — HTTPS from Cloudflare Worker to us-east-1 primary.

³ [Upstash vs KV blog](https://upstash.com/blog/upstash-redis-vs-cloudflare-kv) and [Cloudflare KV changelog](https://developers.cloudflare.com/changelog/post/2025-08-22-kv-performance-improvements/).

**Where lmdis fits:** For a **single-node, self-hosted** deployment, lmdis GET latency (~0.2 ms p50 in the reference run) is in the same ballpark as co-located Redis for simple reads, while paying the HTTP/JSON tax on writes (~3 ms vs ~0.17 ms for native Redis). It avoids managed-service WAN latency but does not replicate globally like Upstash or KV.

---

## Architectural factors

### Why lmdis writes are slower than reads

1. **HTTP + JSON** — Each command is a POST with Zod validation and a JSON response.
2. **LMDB durability** — Writes go through LMDB transactions (memory-mapped, fsync policy depends on OS/page cache).
3. **TTL metadata** — SET with `EX`/`PX` writes both the value and an expiry index key (`e\x00<key>`).
4. **No pipelining** — The SDK sends one command per HTTP request.

### Why lmdis differs from managed edge KV

- **No geographic replication** — All data lives on one LMDB directory; no cross-region read replicas.
- **Strong local consistency** — Reads reflect the latest local write immediately (unlike KV’s eventual model).
- **Lazy TTL expiry** — Expired string keys are removed on read, not by a background sweeper ([`src/store.ts`](./src/store.ts)).

### When to choose what

| Need | Consider |
|------|----------|
| Maximum ops/sec on one machine | Local Redis with pipelining |
| Serverless / multi-region without ops | Upstash Redis |
| Edge config blobs, rare writes | Cloudflare KV |
| Single-node HTTP KV, Bun-native, copy-paste SDK | lmdis |

---

## Sources

1. **Arm Learning Paths** — [Benchmark Redis](https://learn.arm.com/learning-paths/servers-and-cloud-computing/redis-data-searching/benchmarking/) — `redis-benchmark` SET/GET on Arm64 C4A (~150k ops/s, ~0.17 ms avg).
2. **ioredis** — [GitHub README — Benchmarks / Autopipelining](https://github.com/redis/ioredis?tab=readme-ov-file#benchmarks) — pipelining gains.
3. **Upstash** — [Global Replication docs](https://upstash.com/docs/common/concepts/global-replication) — sub-ms same-region reads.
4. **Upstash** — [Upstash Redis vs Cloudflare KV (2026)](https://upstash.com/blog/upstash-redis-vs-cloudflare-kv) — head-to-head from Cloudflare Worker (IAD).
5. **Upstash** — [Benchmarking Cloudflare KV vs Upstash Redis](https://upstash.com/blog/edgecaching-benchmark) — global latency under ~400 RPS load.
6. **Upstash** — [Serverless database connections](https://upstash.com/blog/serverless-database-connections) — connection reuse vs ephemeral latency.
7. **Deno** — [Comparing Deno KV, Upstash, Cloudflare KV, DynamoDB, Firestore](https://deno.com/blog/comparing-deno-kv) — global read/write percentiles (10k samples).
8. **Deno** — [denoland/deno-kv-benchmarks](https://github.com/denoland/deno-kv-benchmarks) — open benchmark harness.
9. **Cloudflare** — [Workers KV performance improvements changelog (Aug 2025)](https://developers.cloudflare.com/changelog/post/2025-08-22-kv-performance-improvements/) — p95/p99 read improvements.
10. **Cloudflare** — [We made Workers KV up to 3x faster](https://blog.cloudflare.com/workers-kv-low-latency/) — hot read < 1 ms, tiered cache.
11. **Zhen Wang** — [Performance characteristics of Cloudflare Workers KV](https://zmxv.medium.com/performance-characteristics-of-cloudflare-workers-kv-ef44ed7990b9) — write/miss ~200 ms; [open-source harness](https://github.com/voggle/cf-perf).
12. **bruceharrison1984** — [kv-d1-benchmark](https://github.com/bruceharrison1984/kv-d1-benchmark) — single-zone KV read/write timings.

---

## Limitations of this comparison

- **Different clients:** lmdis benchmark uses Bun `fetch` + JSON; Redis benchmarks use `redis-benchmark` or RESP clients; KV benchmarks often use Workers bindings (zero HTTP hop).
- **Different hardware:** Reference lmdis numbers are from one developer machine; Arm/Google numbers use cloud VMs.
- **Feature scope:** lmdis implements a subset of Redis commands; no `MULTI`/`EXEC`, pub/sub, or native pipelining.
- **No managed SLA:** Self-hosted performance depends on disk, CPU, concurrent load, and whether rate limiting or access logging is enabled.

For production sizing, run `bun run benchmark` on the target host with `LMDIS_RATE_LIMIT` disabled and representative payload sizes.
