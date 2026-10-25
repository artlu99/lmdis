import { type AuthConfig, authorize } from "./auth";
import { handleCommand } from "./commands";
import { handleSweepExpired, startBackgroundSweeper } from "./expiry";
import { withAccessLog } from "./log";
import {
  checkStoreReady,
  createMetricsUpdater,
  metricsHandler,
  recordRateLimitRejected,
  withMetrics,
} from "./metrics";
import { createRateLimiter, type RateLimitConfig } from "./rate-limit";
import { docsHtml, spec } from "./schemas";
import { backfillIndexIfNeeded, createStore, type Store } from "./store";

export type RouteConfig = {
  rateLimit?: RateLimitConfig | false;
  accessLog?: boolean;
};

export type RouteRuntime = {
  startTime?: number;
  lmdbPath?: string;
};

const withAuth =
  (auth: AuthConfig) =>
    <T extends Request>(handler: (req: T) => Response | Promise<Response>) =>
      async (req: T) => {
        const denied = authorize(req, auth);
        if (denied) return denied;
        return handler(req);
      };

const withRateLimit =
  (check: (req: Request) => Response | null) =>
    <T extends Request>(handler: (req: T) => Response | Promise<Response>) =>
      async (req: T) => {
        const denied = check(req);
        if (denied) return denied;
        return handler(req);
      };

export const createRoutes = (
  store: Store,
  auth: AuthConfig,
  config: RouteConfig = {},
  runtime: RouteRuntime = {},
) => {
  const startTime = runtime.startTime ?? Date.now();
  const lmdbPath = runtime.lmdbPath ?? "data/lmdb";
  const updateMetrics = createMetricsUpdater({ store, lmdbPath, startTime });
  const rateLimit =
    config.rateLimit === false || config.rateLimit === undefined
      ? undefined
      : createRateLimiter(config.rateLimit);
  const accessLog = config.accessLog ?? false;

  const wrap = (
    handler: (req: Request) => Response | Promise<Response>,
    needsAuth: boolean,
    options: { skipRateLimit?: boolean } = {},
  ) => {
    let h = handler;
    if (needsAuth) h = withAuth(auth)(h);
    if (rateLimit && !options.skipRateLimit) h = withRateLimit(rateLimit)(h);
    h = withMetrics(h);
    if (accessLog) h = withAccessLog(h);
    return h;
  };

  const readyHandler = () => {
    if (!checkStoreReady(store)()) {
      return Response.json({ status: "not ready" }, { status: 503 });
    }
    return Response.json({ status: "ready" });
  };

  return {
    "/": {
      GET: wrap(
        () =>
          new Response(null, { status: 302, headers: { Location: "/docs" } }),
        false,
      ),
      POST: wrap(handleCommand(store), true),
    },
    "/health": wrap(() => Response.json({ status: "ok" }), false),
    "/ready": wrap(readyHandler, false, { skipRateLimit: true }),
    "/metrics": wrap(metricsHandler(updateMetrics), true, {
      skipRateLimit: true,
    }),
    "/uptime": wrap(
      () =>
        Response.json({
          uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        }),
      true,
    ),
    "/admin/sweep-expired": {
      POST: wrap(handleSweepExpired(store), true, { skipRateLimit: true }),
    },
    "/openapi.json": wrap(() => Response.json(spec), false),
    "/docs": wrap(
      () =>
        new Response(docsHtml, { headers: { "Content-Type": "text/html" } }),
      false,
    ),
  };
};

export { createStore };

if (import.meta.main) {
  const token = process.env.LMDIS_REST_TOKEN;
  if (!token) {
    console.error("LMDIS_REST_TOKEN is required");
    process.exit(1);
  }
  const port = Number(process.env.PORT) || 3000;
  const rateLimitRpm = Number(process.env.LMDIS_RATE_LIMIT);
  const lmdbPath = process.env.LMDB_PATH || "data/lmdb";
  const startTime = Date.now();
  const store = createStore(lmdbPath);
  await backfillIndexIfNeeded(store)();
  const stopSweeper = startBackgroundSweeper(store);
  const server = Bun.serve({
    port,
    routes: createRoutes(
      store,
      { token },
      {
        rateLimit:
          rateLimitRpm > 0
            ? {
              maxRequests: rateLimitRpm,
              windowMs: 60_000,
              onRejected: recordRateLimitRejected,
            }
            : false,
        accessLog: process.env.LMDIS_ACCESS_LOG === "1",
      },
      { startTime, lmdbPath },
    ),
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down`);
    stopSweeper();
    server.stop();
    await store.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log(`Listening on :${port}`);
}
