import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { countLogicalKeys, type Store } from "./store";

export const registry = new Registry();

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

export const httpRequestDurationSeconds = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const httpRequestsInFlight = new Gauge({
  name: "http_requests_in_flight",
  help: "HTTP requests currently being handled",
  registers: [registry],
});

export const lmdisCommandsTotal = new Counter({
  name: "lmdis_commands_total",
  help: "Total KV commands executed",
  labelNames: ["command", "status"],
  registers: [registry],
});

export const lmdisCommandErrorsTotal = new Counter({
  name: "lmdis_command_errors_total",
  help: "Total KV command errors",
  labelNames: ["command", "code"],
  registers: [registry],
});

export const lmdisRateLimitRejectedTotal = new Counter({
  name: "lmdis_rate_limit_rejected_total",
  help: "Total requests rejected by rate limiting",
  registers: [registry],
});

export const lmdisUptimeSeconds = new Gauge({
  name: "lmdis_uptime_seconds",
  help: "Process uptime in seconds",
  registers: [registry],
});

export const lmdisReady = new Gauge({
  name: "lmdis_ready",
  help: "1 if the store is ready to serve traffic, 0 otherwise",
  registers: [registry],
});

export const processResidentMemoryBytes = new Gauge({
  name: "process_resident_memory_bytes",
  help: "Process resident set size in bytes",
  registers: [registry],
});

export const lmdisLmdbDiskBytes = new Gauge({
  name: "lmdis_lmdb_disk_bytes",
  help: "Total on-disk size of the LMDB data directory in bytes",
  registers: [registry],
});

export const lmdisKeysTotal = new Gauge({
  name: "lmdis_keys_total",
  help: "Number of logical keys in the store index",
  registers: [registry],
});

export const lmdisExpiredKeysRemovedTotal = new Counter({
  name: "lmdis_expired_keys_removed_total",
  help: "Total expired string keys removed (lazy eviction and sweep)",
  registers: [registry],
});

export const lmdisSweepErrorsTotal = new Counter({
  name: "lmdis_sweep_errors_total",
  help: "Total background TTL sweep batches that failed",
  registers: [registry],
});

const KNOWN_ROUTES = new Set([
  "/",
  "/admin/sweep-expired",
  "/health",
  "/ready",
  "/metrics",
  "/uptime",
  "/docs",
  "/openapi.json",
]);

export const routeLabel = (pathname: string) =>
  KNOWN_ROUTES.has(pathname) ? pathname : "unknown";

export const withMetrics =
  <T extends Request>(handler: (req: T) => Response | Promise<Response>) =>
  async (req: T) => {
    const route = routeLabel(new URL(req.url).pathname);
    const start = Date.now();
    httpRequestsInFlight.inc();
    try {
      const res = await handler(req);
      const status = String(res.status);
      httpRequestsTotal.inc({ method: req.method, route, status });
      httpRequestDurationSeconds.observe(
        { method: req.method, route },
        (Date.now() - start) / 1000,
      );
      return res;
    } catch (e) {
      httpRequestsTotal.inc({ method: req.method, route, status: "500" });
      httpRequestDurationSeconds.observe(
        { method: req.method, route },
        (Date.now() - start) / 1000,
      );
      throw e;
    } finally {
      httpRequestsInFlight.dec();
    }
  };

export const recordCommand = (command: string, status: number, code?: string) => {
  lmdisCommandsTotal.inc({ command, status: String(status) });
  if (code && status >= 400) lmdisCommandErrorsTotal.inc({ command, code });
};

export const recordRateLimitRejected = () => {
  lmdisRateLimitRejectedTotal.inc();
};

export const recordExpiredKeyRemoved = (count = 1) => {
  lmdisExpiredKeysRemovedTotal.inc(count);
};

export const recordSweepError = () => {
  lmdisSweepErrorsTotal.inc();
};

export const checkStoreReady = (store: Store) => (): boolean => {
  try {
    store.get("__lmdis_ready_probe__");
    return true;
  } catch {
    return false;
  }
};

const dirSizeBytes = async (path: string): Promise<number> => {
  let total = 0;
  const glob = new Bun.Glob("**/*");
  for await (const file of glob.scan({ cwd: path, onlyFiles: true })) {
    const stat = await Bun.file(`${path}/${file}`).stat();
    if (stat) total += stat.size;
  }
  return total;
};

export type MetricsContext = {
  store: Store;
  lmdbPath: string;
  startTime: number;
};

const KEY_COUNT_CACHE_MS = 30_000;

export const createMetricsUpdater = (ctx: MetricsContext) => {
  let keyCountCache = { at: 0, value: 0 };

  return async () => {
    lmdisUptimeSeconds.set(Math.floor((Date.now() - ctx.startTime) / 1000));
    processResidentMemoryBytes.set(process.memoryUsage().rss);
    lmdisReady.set(checkStoreReady(ctx.store)() ? 1 : 0);

    try {
      lmdisLmdbDiskBytes.set(await dirSizeBytes(ctx.lmdbPath));
    } catch {
      lmdisLmdbDiskBytes.set(0);
    }

    const now = Date.now();
    if (now - keyCountCache.at >= KEY_COUNT_CACHE_MS) {
      keyCountCache = { at: now, value: countLogicalKeys(ctx.store)() };
    }
    lmdisKeysTotal.set(keyCountCache.value);
  };
};

export const metricsHandler = (update: () => Promise<void>) => async () => {
  await update();
  return new Response(await registry.metrics(), {
    headers: { "Content-Type": registry.contentType },
  });
};
