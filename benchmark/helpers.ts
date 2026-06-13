import { createRoutes } from "../src/index";
import { LmdisClient } from "../src/sdk";
import { createStore, type Store } from "../src/store";

export type BenchmarkServer = {
  store: Store;
  server: ReturnType<typeof Bun.serve>;
  baseUrl: string;
  token: string;
  client: LmdisClient;
};

const BENCH_TOKEN = "benchmark-token";

export const createRunId = (): string =>
  `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

export const keyPrefix = (runId: string): string => `bench:${runId}:`;

export const benchKey = (runId: string, suffix: string): string => `${keyPrefix(runId)}${suffix}`;

export const startEmbeddedServer = (dbPath: string): BenchmarkServer => {
  const store = createStore(dbPath);
  const server = Bun.serve({
    port: 0,
    routes: createRoutes(store, { token: BENCH_TOKEN }, { rateLimit: false, accessLog: false }),
  });
  const port = server.port;
  if (!port) throw new Error("failed to bind benchmark server");
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = new LmdisClient({ url: baseUrl, token: BENCH_TOKEN });
  return { store, server, baseUrl, token: BENCH_TOKEN, client };
};

export const connectExternalServer = (): BenchmarkServer => {
  const url = process.env.LMDIS_URL ?? "http://127.0.0.1:3000";
  const token = process.env.LMDIS_REST_TOKEN;
  if (!token) {
    throw new Error("LMDIS_REST_TOKEN is required when not using embedded mode (set BENCHMARK_EMBEDDED=1)");
  }
  const client = new LmdisClient({ url, token });
  return { store: null as unknown as Store, server: null as unknown as ReturnType<typeof Bun.serve>, baseUrl: url, token, client };
};

export const cleanupRun = async (client: LmdisClient, runId: string): Promise<number> => {
  const pattern = `${keyPrefix(runId)}*`;
  const keys = await client.keys(pattern);
  if (keys.length === 0) return 0;
  return client.del(...keys);
};

export const parseEnvInt = (name: string, fallback: number, min: number, max: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got ${raw}`);
  }
  return value;
};
