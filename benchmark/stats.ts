export type LatencyStats = {
  samples: number;
  meanMs: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  opsPerSec: number;
  durationMs: number;
};

export const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? 0;
};

export const summarizeLatencies = (latenciesMs: number[], durationMs: number): LatencyStats => {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    samples: sorted.length,
    meanMs: sorted.length ? sum / sorted.length : 0,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    opsPerSec: durationMs > 0 ? (sorted.length / durationMs) * 1000 : 0,
    durationMs,
  };
};

export const formatStats = (label: string, stats: LatencyStats): string => {
  const fmt = (n: number) => n.toFixed(3);
  return [
    `${label}`,
    `  samples: ${stats.samples}`,
    `  throughput: ${fmt(stats.opsPerSec)} ops/s`,
    `  mean: ${fmt(stats.meanMs)} ms`,
    `  p50: ${fmt(stats.p50Ms)} ms`,
    `  p95: ${fmt(stats.p95Ms)} ms`,
    `  p99: ${fmt(stats.p99Ms)} ms`,
    `  max: ${fmt(stats.maxMs)} ms`,
  ].join("\n");
};
