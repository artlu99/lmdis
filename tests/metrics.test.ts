import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createStore } from "../src/index";
import { registry } from "../src/metrics";
import { resetStore } from "../src/store";
import { authHeaders, startTestServer } from "./test-helpers";

const storePath = "data/test-metrics";
const store = createStore(storePath);
const { server, base } = startTestServer(store, undefined, { lmdbPath: storePath });

afterAll(() => server.stop());
beforeEach(async () => {
  registry.resetMetrics();
  await resetStore(store)();
});

test("GET /metrics returns prometheus exposition format", async () => {
  const res = await fetch(`${base}/metrics`, { headers: authHeaders });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
  const body = await res.text();
  expect(body).toContain("http_requests_total");
  expect(body).toContain("lmdis_uptime_seconds");
});

test("GET /metrics requires bearer auth", async () => {
  const res = await fetch(`${base}/metrics`);
  expect(res.status).toBe(401);
});

test("GET /ready returns ready when store is open", async () => {
  const res = await fetch(`${base}/ready`);
  expect(res.status).toBe(200);
  const data = (await res.json()) as { status: string };
  expect(data.status).toBe("ready");
});

test("POST SET increments lmdis_commands_total", async () => {
  await fetch(base, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(["SET", "metrics-key", "value"]),
  });

  const metrics = await (await fetch(`${base}/metrics`, { headers: authHeaders })).text();
  expect(metrics).toContain('lmdis_commands_total{command="SET",status="200"} 1');
});

test("validation errors increment lmdis_command_errors_total", async () => {
  await fetch(base, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(["GET", ""]),
  });

  const metrics = await (await fetch(`${base}/metrics`, { headers: authHeaders })).text();
  expect(metrics).toContain('lmdis_command_errors_total{command="unknown",code="VALIDATION_ERROR"} 1');
});

describe("rate limiting", () => {
  const limitedStore = createStore("data/test-metrics-rate");
  const { server: limitedServer, base: limitedBase } = startTestServer(limitedStore, {
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
  });
  afterAll(() => limitedServer.stop());
  beforeEach(async () => {
    registry.resetMetrics();
    await resetStore(limitedStore)();
  });

  test("/metrics is excluded from rate limiting", async () => {
    const headers = { "x-forwarded-for": "10.0.0.99" };
    const res1 = await fetch(`${limitedBase}/health`, { headers });
    expect(res1.status).toBe(200);
    const res2 = await fetch(`${limitedBase}/health`, { headers });
    expect(res2.status).toBe(429);

    const metrics1 = await fetch(`${limitedBase}/metrics`, { headers: { ...headers, ...authHeaders } });
    const metrics2 = await fetch(`${limitedBase}/metrics`, { headers: { ...headers, ...authHeaders } });
    expect(metrics1.status).toBe(200);
    expect(metrics2.status).toBe(200);
  });
});
