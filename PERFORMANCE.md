# Performance

lmdis is a **self-hosted HTTP KV store** (LMDB + JSON REST). Most performance leakage comes from internet routing layer.

The numbers below mix **benchmarking runs** with **published third-party results**. Treat the comparison as directional, not a scientific comparison of apples-for-apples.

---

## At a glance

| Store | GET p50 (typical) | SET p50 (typical) | Transport | Replication |
|-------|-------------------|-------------------|-----------|-------------|
| **lmdis** (same host) | ~0.2 ms | ~3 ms | HTTP JSON | None |
| **lmdis** (remote HTTPS) | ~22 ms | ~25 ms | HTTP JSON | None |
| **Upstash Redis** (REST, edge→region) | ~7 ms | ~6 ms | HTTP REST | Global |
| **Upstash Redis** (same AWS region) | < 1 ms | ~6 ms | HTTP REST | Optional |
| **Local Redis** (same host) | ~0.17 ms | ~0.17 ms | TCP (RESP) | Manual |
| **Cloudflare KV** (cached read) | ~3 ms | ~170 ms | Worker binding | Edge cache |
| **Cloudflare KV** (cold read / write) | ~31 ms | ~170 ms | Worker binding | Edge cache |

---

## lmdis vs Upstash

Both speak **HTTP** — one request per command, JSON on the wire. Upstash adds managed global replicas; lmdis is a single LMDB directory you host.

### By workload

| Workload | lmdis local | lmdis remote | Upstash REST¹ | Who wins |
|----------|-------------|--------------|---------------|----------|
| GET / read | 0.2 ms p50 | 21.9 ms p50 | 6.8 ms p50 (cold) | Local lmdis; Upstash beats remote lmdis |
| SET / write | 2.8 ms p50 | 24.5 ms p50 | 6.2 ms p50 | Upstash beats remote; local lmdis competitive |
| Read-after-write | ~3 ms | ~24 ms | 24.8 ms p50 | Tie at remote; local lmdis wins |
| GET p99 tail | 1.5 ms | 41.7 ms | 28.2 ms | Local lmdis; Upstash tighter than remote lmdis |
| SET p99 tail | 9.4 ms | 117 ms | 8.6 ms | Upstash — remote lmdis has long tails |
| Throughput (sequential GET) | ~3,600 ops/s | ~42 ops/s | varies by region | Local lmdis; both HTTP stores slow over WAN |

¹ [Upstash vs Cloudflare KV (2026)](https://upstash.com/blog/upstash-redis-vs-cloudflare-kv) — Cloudflare Worker in IAD → Upstash primary in us-east-1. Global reads: [Deno benchmark](https://deno.com/blog/comparing-deno-kv) reports **19 ms p50 / 139 ms p99**. Same-region reads: [Upstash docs](https://upstash.com/docs/common/concepts/global-replication) claim **sub-millisecond**.

### Summary

| | lmdis | Upstash |
|--|-------|---------|
| **Co-located client** | GET ~0.2 ms — **faster** than Upstash's edge path | Same-region sub-ms reads possible |
| **Remote client** | ~22 ms p50 — **3–4× slower** than Upstash REST (~6 ms) | Optimized edge→AWS routing |
| **Ops burden** | You host one process + LMDB dir | Fully managed, global replicas |
| **Consistency** | Strong, single node | Eventual when globally replicated |
| **Cost model** | Your VPS | Per-request + storage |

**Pick lmdis** when the app and store share a host (or VPC) and you want zero vendor lock-in. **Pick Upstash** when clients are serverless/edge everywhere and you need multi-region without running infra.

---

## lmdis vs local Redis

Redis uses **TCP + RESP** — no HTTP, no JSON, optional pipelining. It's the throughput ceiling for key/value on one machine.

| | lmdis (local) | Local Redis² |
|--|---------------|--------------|
| GET p50 | 0.2 ms | 0.17 ms |
| SET p50 | 2.8 ms | 0.17 ms |
| Throughput | ~3,600 GET ops/s | ~150,000 ops/s |
| Relative speed | 1× (baseline) | **~10–50× faster** raw ops |
| Setup | Single Bun binary + LMDB | Redis server + client |
| API surface | Subset via HTTP | Full Redis |

² [Arm redis-benchmark](https://learn.arm.com/learning-paths/servers-and-cloud-computing/redis-data-searching/benchmarking/) — 100k requests, 50 concurrent clients, Google Axion C4A VM. [ioredis](https://github.com/redis/ioredis?tab=readme-ov-file#benchmarks) pipelining adds another **50–300%**.

**Pick lmdis** for a lightweight HTTP KV with a copy-paste SDK — no Redis to install. **Pick Redis** when you need maximum ops/sec, pub/sub, transactions, or the full command set.

---

## lmdis vs Cloudflare KV

KV is **eventually consistent** and **write-heavy slow** — optimized for config blobs and cached reads at the edge, not a primary database.

| Workload | lmdis remote | Cloudflare KV³ | Notes |
|----------|--------------|----------------|-------|
| Hot read p50 | 21.9 ms | 2.6 ms | KV wins — in-memory regional cache |
| Cold read p50 | 21.9 ms | 30.6 ms | Roughly similar |
| Write p50 | 24.5 ms | 171.8 ms | lmdis **~7× faster** |
| Read-after-write p50 | ~24 ms | 176.2 ms | lmdis **~7× faster** — KV propagation is slow |
| Global read p99 | 41.7 ms (one client) | 742 ms (Deno global)⁴ | KV tails badly under global load |

³ [Upstash vs KV (2026)](https://upstash.com/blog/upstash-redis-vs-cloudflare-kv), [Cloudflare KV changelog (Aug 2025)](https://developers.cloudflare.com/changelog/post/2025-08-22-kv-performance-improvements/) (~50 ms p95 reads), [Cloudflare blog](https://blog.cloudflare.com/workers-kv-low-latency/) (< 1 ms hot reads).

⁴ [Deno KV comparison](https://deno.com/blog/comparing-deno-kv) — 10k samples, global traffic.

**Pick lmdis** when you write often or need immediate read-your-writes consistency. **Pick KV** when data is read-heavy, rarely changes, and lives inside Cloudflare Workers.

---

## Side-by-side: all four stores

Scenario-level view using our lmdis runs + published benchmarks for the others.

| Scenario | lmdis local | lmdis remote | Upstash REST | Local Redis | CF KV |
|----------|-------------|--------------|--------------|-------------|-------|
| GET p50 | **0.2 ms** | 21.9 ms | 6.8 ms | **0.17 ms** | 2.6 ms (hot) |
| GET p99 | **1.5 ms** | 41.7 ms | 28.2 ms | **0.19 ms** | 5.8 ms (hot) |
| SET p50 | 2.8 ms | 24.5 ms | **6.2 ms** | **0.17 ms** | 171.8 ms |
| SET p99 | 9.4 ms | 117 ms | **8.6 ms** | **0.19 ms** | 253.2 ms |
| Sequential GET throughput | **3,600/s** | 42/s | — | **150,000/s** | — |
| Strong consistency | Yes | Yes | Eventual (global) | Yes | No |
| Self-hosted | Yes | Yes | No | Yes | No |

**Fastest reads (same machine):** local Redis ≈ lmdis ≪ Upstash REST ≪ remote lmdis  
**Fastest writes (remote/serverless):** Upstash ≈ remote lmdis ≪ Cloudflare KV  
**Best edge cached reads:** Cloudflare KV (hot keys only)

---

## lmdis benchmark results

500 sequential ops, 256-byte values, one HTTP request per command.  
`BENCHMARK_EMBEDDED=1 bun run benchmark` (local) · `bun run benchmark` (remote via `LMDIS_URL`).

### Local (loopback)

| Scenario | p50 | p99 | Throughput |
|----------|-----|-----|------------|
| GET (hot key) | 0.2 ms | 1.5 ms | ~3,600 ops/s |
| SET (with TTL) | 2.8 ms | 9.4 ms | ~305 ops/s |
| Mixed SET/GET | 1.1 ms | 3.8 ms | ~841 ops/s |
| HINCR | 1.7 ms | 3.7 ms | ~543 ops/s |
| SADD + SMEMB | 2.4 ms | 8.1 ms | ~389 ops/s |

### Remote ([production run](./benchmark/results/mqcdqbb8-af6fae77.json))

| Scenario | p50 | p99 | Throughput |
|----------|-----|-----|------------|
| GET (hot key) | 21.9 ms | 41.7 ms | ~42 ops/s |
| SET (with TTL) | 24.5 ms | 117 ms | ~25 ops/s |
| Mixed SET/GET | 23.6 ms | 81 ms | ~38 ops/s |
| HINCR | 24.6 ms | 2,106 ms | ~10 ops/s |
| SADD + SMEMB | 47.8 ms | 66.8 ms | ~20 ops/s |

Remote GET ≈ SET because **network RTT dominates** — the local read advantage disappears over HTTPS.

---

## When to use what

| You need… | Pick |
|-----------|------|
| Fastest KV on same host as app | **Local Redis** (max ops) or **lmdis** (HTTP, simpler) |
| Self-hosted HTTP API, no Redis install | **lmdis** |
| Serverless / multi-region, managed | **Upstash** |
| Workers-only config, mostly reads | **Cloudflare KV** |
| Frequent writes + immediate consistency | **lmdis** or **Upstash** — not KV |

---

## Running the benchmark

```sh
BENCHMARK_EMBEDDED=1 bun run benchmark   # local baseline
bun run benchmark                        # remote — set LMDIS_URL + LMDIS_REST_TOKEN
```

Idempotent: keys prefixed `bench:<runId>:`, 120 s TTL on strings, hash/set keys deleted at end. Results → `benchmark/results/<runId>.json`.

Disable `LMDIS_RATE_LIMIT` for fair remote runs (~2,500 requests per full benchmark).

---

## Sources

- [Upstash vs Cloudflare KV (2026)](https://upstash.com/blog/upstash-redis-vs-cloudflare-kv)
- [Upstash global replication docs](https://upstash.com/docs/common/concepts/global-replication)
- [Deno KV comparison (10k samples)](https://deno.com/blog/comparing-deno-kv)
- [Arm — redis-benchmark](https://learn.arm.com/learning-paths/servers-and-cloud-computing/redis-data-searching/benchmarking/)
- [Cloudflare KV performance changelog (Aug 2025)](https://developers.cloudflare.com/changelog/post/2025-08-22-kv-performance-improvements/)
- [Cloudflare — KV up to 3× faster](https://blog.cloudflare.com/workers-kv-low-latency/)
- [Cloudflare KV characteristics (Zhen Wang)](https://zmxv.medium.com/performance-characteristics-of-cloudflare-workers-kv-ef44ed7990b9)
