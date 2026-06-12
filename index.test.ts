import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createStore } from "./index";
import { resetStore } from "./store";
import { authHeaders, startTestServer } from "./test-helpers";

const store = createStore("data/test-index");
const { server, base } = startTestServer(store);

afterAll(() => server.stop());
beforeAll(() => resetStore(store)());

test("/health", async () => {
  const data = (await (await fetch(`${base}/health`)).json()) as { status: string };
  expect(data.status).toBe("ok");
});

test("/uptime", async () => {
  const data = (await (await fetch(`${base}/uptime`, { headers: authHeaders })).json()) as {
    uptimeSeconds: number;
  };
  expect(data.uptimeSeconds).toBeGreaterThanOrEqual(0);
});

describe("rate limiting", () => {
  const limitedStore = createStore("data/test-index-rate");
  const { server: limitedServer, base: limitedBase } = startTestServer(limitedStore, {
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
  });
  afterAll(() => limitedServer.stop());

  test("returns 429 when limit exceeded", async () => {
    const headers = { ...authHeaders, "x-forwarded-for": "10.0.0.1" };
    const res1 = await fetch(`${limitedBase}/health`, { headers });
    expect(res1.status).toBe(200);
    const res2 = await fetch(`${limitedBase}/health`, { headers });
    expect(res2.status).toBe(429);
    const body = (await res2.json()) as { code: string };
    expect(body.code).toBe("RATE_LIMITED");
  });
});

test("removed path routes return 404", async () => {
  const paths = [
    "/set/k/v",
    "/get/k",
    "/del/k",
    "/hincr/k/f/1",
    "/sadd/k/m",
    "/smemb/k",
    "/sdel/k/m",
  ];
  for (const path of paths) {
    const res = await fetch(`${base}${path}`, { headers: authHeaders });
    expect(res.status).toBe(404);
  }
});
