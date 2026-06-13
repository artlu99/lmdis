/**
 * lmdis performance benchmark.
 *
 * Idempotent: all keys use prefix bench:<runId>: with TTL on string values.
 * Non-string keys (hash/set) are explicitly deleted at the end of each run.
 * Re-running is safe; leftover keys from crashed runs expire within TTL (default 2 min).
 *
 * Usage:
 *   BENCHMARK_EMBEDDED=1 bun run benchmark/run.ts
 *   LMDIS_REST_TOKEN=... bun run benchmark/run.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  benchKey,
  cleanupRun,
  connectExternalServer,
  createRunId,
  parseEnvInt,
  startEmbeddedServer,
  type BenchmarkServer,
} from "./helpers";
import type { LatencyStats } from "./stats";
import { formatStats, summarizeLatencies } from "./stats";

type ScenarioResult = {
  name: string;
  stats: LatencyStats;
  payloadBytes?: number;
};

type BenchmarkReport = {
  runId: string;
  timestamp: string;
  mode: "embedded" | "external";
  baseUrl: string;
  ttlSec: number;
  iterations: number;
  warmup: number;
  valueSize: number;
  scenarios: ScenarioResult[];
  cleanup: { keysRemoved: number };
};

const ITERATIONS = parseEnvInt("BENCHMARK_ITERATIONS", 500, 10, 50_000);
const WARMUP = parseEnvInt("BENCHMARK_WARMUP", 50, 0, 10_000);
const TTL_SEC = parseEnvInt("BENCHMARK_TTL_SEC", 120, 60, 300);
const VALUE_SIZE = parseEnvInt("BENCHMARK_VALUE_SIZE", 256, 8, 65_536);
const EMBEDDED = process.env.BENCHMARK_EMBEDDED === "1" || process.env.BENCHMARK_EMBEDDED === "true";

const sampleValue = (size: number): string => "x".repeat(size);

const timedLoop = async (
  count: number,
  fn: (i: number) => Promise<void>,
): Promise<{ latenciesMs: number[]; durationMs: number }> => {
  const latenciesMs: number[] = [];
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    await fn(i);
    latenciesMs.push(performance.now() - t0);
  }
  return { latenciesMs, durationMs: performance.now() - start };
};

const benchSet = async (
  client: BenchmarkServer["client"],
  runId: string,
  iterations: number,
  valueSize: number,
  ttlSec: number,
): Promise<ScenarioResult> => {
  const value = sampleValue(valueSize);
  const { latenciesMs, durationMs } = await timedLoop(iterations, async (i) => {
    await client.set(benchKey(runId, `set:${i}`), value, { ex: ttlSec });
  });
  return {
    name: "SET (string, with TTL)",
    payloadBytes: valueSize,
    stats: summarizeLatencies(latenciesMs, durationMs),
  };
};

const benchGet = async (
  client: BenchmarkServer["client"],
  runId: string,
  iterations: number,
  valueSize: number,
  ttlSec: number,
  warmup: number,
): Promise<ScenarioResult> => {
  const value = sampleValue(valueSize);
  const key = benchKey(runId, "get:hot");
  await client.set(key, value, { ex: ttlSec });
  for (let i = 0; i < warmup; i++) await client.get(key);

  const { latenciesMs, durationMs } = await timedLoop(iterations, async () => {
    await client.get(key);
  });
  return {
    name: "GET (hot key)",
    payloadBytes: valueSize,
    stats: summarizeLatencies(latenciesMs, durationMs),
  };
};

const benchMixed = async (
  client: BenchmarkServer["client"],
  runId: string,
  iterations: number,
  valueSize: number,
  ttlSec: number,
): Promise<ScenarioResult> => {
  const value = sampleValue(valueSize);
  const { latenciesMs, durationMs } = await timedLoop(iterations, async (i) => {
    const key = benchKey(runId, `mix:${i % 32}`);
    if (i % 2 === 0) {
      await client.set(key, value, { ex: ttlSec });
    } else {
      await client.get(key);
    }
  });
  return {
    name: "Mixed 50/50 SET/GET (32-key working set)",
    payloadBytes: valueSize,
    stats: summarizeLatencies(latenciesMs, durationMs),
  };
};

const benchHincr = async (
  client: BenchmarkServer["client"],
  runId: string,
  iterations: number,
): Promise<ScenarioResult> => {
  const key = benchKey(runId, "counter");
  const { latenciesMs, durationMs } = await timedLoop(iterations, async () => {
    await client.hincrby(key, "n", 1);
  });
  return {
    name: "HINCR (hash field increment)",
    stats: summarizeLatencies(latenciesMs, durationMs),
  };
};

const benchSetOps = async (
  client: BenchmarkServer["client"],
  runId: string,
  iterations: number,
): Promise<ScenarioResult> => {
  const key = benchKey(runId, "tags");
  const { latenciesMs, durationMs } = await timedLoop(iterations, async (i) => {
    await client.sadd(key, `m${i}`);
    await client.smembers(key);
  });
  return {
    name: "SADD + SMEMB (per iteration)",
    stats: summarizeLatencies(latenciesMs, durationMs),
  };
};

const runBenchmark = async (): Promise<BenchmarkReport> => {
  const runId = createRunId();
  const embedded = EMBEDDED;
  const benchServer = embedded
    ? startEmbeddedServer(`data/benchmark-${runId}`)
    : connectExternalServer();

  console.log(`lmdis benchmark runId=${runId}`);
  console.log(`mode=${embedded ? "embedded" : "external"} url=${benchServer.baseUrl}`);
  console.log(`iterations=${ITERATIONS} warmup=${WARMUP} ttl=${TTL_SEC}s valueSize=${VALUE_SIZE}B\n`);

  try {
    const scenarios: ScenarioResult[] = [];
    scenarios.push(await benchSet(benchServer.client, runId, ITERATIONS, VALUE_SIZE, TTL_SEC));
    scenarios.push(await benchGet(benchServer.client, runId, ITERATIONS, VALUE_SIZE, TTL_SEC, WARMUP));
    scenarios.push(await benchMixed(benchServer.client, runId, ITERATIONS, VALUE_SIZE, TTL_SEC));
    scenarios.push(await benchHincr(benchServer.client, runId, Math.min(ITERATIONS, 1000)));
    scenarios.push(await benchSetOps(benchServer.client, runId, Math.min(ITERATIONS, 200)));

    const keysRemoved = await cleanupRun(benchServer.client, runId);

    const report: BenchmarkReport = {
      runId,
      timestamp: new Date().toISOString(),
      mode: embedded ? "embedded" : "external",
      baseUrl: benchServer.baseUrl,
      ttlSec: TTL_SEC,
      iterations: ITERATIONS,
      warmup: WARMUP,
      valueSize: VALUE_SIZE,
      scenarios,
      cleanup: { keysRemoved },
    };

    for (const s of scenarios) {
      console.log(formatStats(s.name, s.stats));
      console.log();
    }
    console.log(`cleanup: removed ${keysRemoved} keys (TTL ${TTL_SEC}s covers any missed string keys)`);

    return report;
  } finally {
    if (embedded) {
      benchServer.server.stop();
      benchServer.store.close();
    }
  }
};

const main = async (): Promise<void> => {
  const report = await runBenchmark();
  const outDir = join(import.meta.dir, "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${report.runId}.json`);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
