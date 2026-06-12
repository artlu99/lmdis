import { authorize, type AuthConfig } from "./auth";
import { handleCommand } from "./commands";
import { withAccessLog } from "./log";
import { createRateLimiter, type RateLimitConfig } from "./rate-limit";
import { docsHtml, spec } from "./schemas";
import { createStore, backfillIndexIfNeeded, type Store } from "./store";

const start = Date.now();

export type RouteConfig = {
  rateLimit?: RateLimitConfig | false;
  accessLog?: boolean;
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

export const createRoutes = (store: Store, auth: AuthConfig, config: RouteConfig = {}) => {
  const rateLimit =
    config.rateLimit === false || config.rateLimit === undefined
      ? undefined
      : createRateLimiter(config.rateLimit);
  const accessLog = config.accessLog ?? false;

  const wrap = (handler: (req: Request) => Response | Promise<Response>, needsAuth: boolean) => {
    let h = handler;
    if (needsAuth) h = withAuth(auth)(h);
    if (rateLimit) h = withRateLimit(rateLimit)(h);
    if (accessLog) h = withAccessLog(h);
    return h;
  };

  return {
    "/": {
      GET: wrap(() => new Response(null, { status: 302, headers: { Location: "/docs" } }), false),
      POST: wrap(handleCommand(store), true),
    },
    "/health": wrap(() => Response.json({ status: "ok" }), false),
    "/uptime": wrap(
      () => Response.json({ uptimeSeconds: Math.floor((Date.now() - start) / 1000) }),
      true,
    ),
    "/openapi.json": wrap(() => Response.json(spec), false),
    "/docs": wrap(
      () => new Response(docsHtml, { headers: { "Content-Type": "text/html" } }),
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
  const store = createStore();
  await backfillIndexIfNeeded(store)();
  const server = Bun.serve({
    port,
    routes: createRoutes(store, { token }, {
      rateLimit: rateLimitRpm > 0 ? { maxRequests: rateLimitRpm, windowMs: 60_000 } : false,
      accessLog: process.env.LMDIS_ACCESS_LOG === "1",
    }),
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down`);
    server.stop();
    await store.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log(`Listening on :${port}`);
}
