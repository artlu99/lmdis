import type { AuthConfig } from "../src/auth";
import type { RouteConfig, RouteRuntime } from "../src/index";
import { createRoutes } from "../src/index";
import type { Store } from "../src/store";

export const TEST_TOKEN = "test-token";
export const testAuth: AuthConfig = { token: TEST_TOKEN };
export const authHeaders = { Authorization: `Bearer ${TEST_TOKEN}` };

export const startTestServer = (
  store: Store,
  config?: RouteConfig,
  runtime?: RouteRuntime,
) => {
  const server = Bun.serve({ port: 0, routes: createRoutes(store, testAuth, config, runtime) });
  const port = server.port;
  if (!port) throw new Error("failed to bind test server");
  return { server, base: `http://localhost:${port}` };
};
