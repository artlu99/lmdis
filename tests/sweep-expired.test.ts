import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createStore } from "../src/index";
import { registry } from "../src/metrics";
import { sweepExpiredBatch } from "../src/expiry";
import { countLogicalKeys, eKey, resetStore } from "../src/store";
import { authHeaders, startTestServer } from "./test-helpers";

const storePath = "data/test-sweep-expired";
const store = createStore(storePath);
const { server, base } = startTestServer(store, undefined, { lmdbPath: storePath });

const cmd = async (...args: unknown[]) => {
  const res = await fetch(base, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return { res, data: res.json() as Promise<{ result: unknown }> };
};

const sweep = async (body: Record<string, unknown> = {}) => {
  const res = await fetch(`${base}/admin/sweep-expired`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    res,
    data: res.json() as Promise<{ cursor: string; removed: number; error?: string; code?: string }>,
  };
};

afterAll(() => server.stop());
beforeEach(async () => {
  registry.resetMetrics();
  await resetStore(store)();
});

describe("sweepExpiredBatch", () => {
  test("removes expired keys and skips live keys", async () => {
    await store.put("live", "v");
    await store.put(eKey("live"), String(Date.now() + 60_000));
    await store.put("dead", "v");
    await store.put(eKey("dead"), String(Date.now() - 1000));

    const result = await sweepExpiredBatch(store)("0", 1000);
    expect(result.removed).toBe(1);
    expect(result.cursor).toBe("0");
    expect(store.get("dead")).toBeUndefined();
    expect(store.get("live")).toBe("v");
  });

  test("paginates with cursor", async () => {
    for (let i = 0; i < 3; i++) {
      const key = `dead-${i}`;
      await store.put(key, "v");
      await store.put(eKey(key), String(Date.now() - 1000));
    }

    const page1 = await sweepExpiredBatch(store)("0", 2);
    expect(page1.removed).toBe(2);
    expect(page1.cursor).not.toBe("0");

    const page2 = await sweepExpiredBatch(store)(page1.cursor, 2);
    expect(page2.removed).toBe(1);
    expect(page2.cursor).toBe("0");
  });

  test("second full pass removes nothing", async () => {
    await store.put("dead", "v");
    await store.put(eKey("dead"), String(Date.now() - 1000));

    const first = await sweepExpiredBatch(store)("0", 1000);
    expect(first.removed).toBe(1);

    const second = await sweepExpiredBatch(store)("0", 1000);
    expect(second.removed).toBe(0);
    expect(second.cursor).toBe("0");
  });

  test("sweeps expired multibyte (CJK/emoji) keys", async () => {
    // Regression: a `prefix + "\xff"` range bound truncated for user keys
    // containing chars ≥ U+0100 (their UTF-8 bytes sort above ÿ-as-U+00FF).
    const keys = ["中文", "clé", "\u{1F600}"];
    for (const key of keys) {
      await store.put(key, "v");
      await store.put(eKey(key), String(Date.now() - 1000));
    }

    const result = await sweepExpiredBatch(store)("0", 1000);
    expect(result.removed).toBe(3);
    expect(result.cursor).toBe("0");
    for (const key of keys) expect(store.get(key)).toBeUndefined();
  });

  test("multibyte keys enumerate and delete cleanly via commands", async () => {
    await cmd("SET", "中文", "值");
    await cmd("SADD", "中文", "成员");

    const keys = ((await (await cmd("KEYS")).data).result) as string[];
    expect(keys).toContain("中文");

    const scanned = ((await (await cmd("SCANKEYS", "0", 100)).data).result) as [string, string[]];
    expect(scanned[1]).toContain("中文");

    const deleted = ((await (await cmd("DEL", "中文")).data).result) as number;
    expect(deleted).toBe(1);

    const keysAfter = ((await (await cmd("KEYS")).data).result) as string[];
    expect(keysAfter).not.toContain("中文");
  });

  test("non-positive limit falls back to default batch size", async () => {
    for (let i = 0; i < 3; i++) {
      const key = `dead-neg-${i}`;
      await store.put(key, "v");
      await store.put(eKey(key), String(Date.now() - 1000));
    }

    const result = await sweepExpiredBatch(store)("0", -1);
    expect(result.removed).toBe(3);
    expect(result.cursor).toBe("0");
  });
});

describe("POST /admin/sweep-expired", () => {
  test("requires auth", async () => {
    const res = await fetch(`${base}/admin/sweep-expired`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  test("sweeps expired keys via HTTP", async () => {
    await cmd("SET", "sweep-a", "v", "EX", 1);
    await cmd("SET", "sweep-b", "v", "EX", 60);
    await Bun.sleep(1100);

    const { res, data } = await sweep({ limit: 1000 });
    expect(res.status).toBe(200);
    const body = await data;
    expect(body.removed).toBe(1);
    expect(body.cursor).toBe("0");

    expect((await (await cmd("GET", "sweep-a")).data).result).toBeNull();
    expect((await (await cmd("GET", "sweep-b")).data).result).toBe("v");
    expect(countLogicalKeys(store)()).toBe(1);
  });

  test("defaults cursor and limit when body is empty", async () => {
    await store.put("dead", "v");
    await store.put(eKey("dead"), String(Date.now() - 1000));

    const { res, data } = await sweep();
    expect(res.status).toBe(200);
    expect((await data).removed).toBe(1);
  });

  test("rejects invalid limit", async () => {
    const { res, data } = await sweep({ limit: 0 });
    expect(res.status).toBe(400);
    expect((await data).code).toBe("VALIDATION_ERROR");
  });

  test("increments lmdis_expired_keys_removed_total", async () => {
    await store.put("dead", "v");
    await store.put(eKey("dead"), String(Date.now() - 1000));

    await sweep({ limit: 1000 });

    const metrics = await (await fetch(`${base}/metrics`, { headers: authHeaders })).text();
    expect(metrics).toContain("lmdis_expired_keys_removed_total 1");
  });
});

describe("POST /admin/sweep-expired rate limiting", () => {
  const limitedStore = createStore("data/test-sweep-rate");
  const { server: limitedServer, base: limitedBase } = startTestServer(limitedStore, {
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
  });

  afterAll(() => limitedServer.stop());

  test("is excluded from rate limiting", async () => {
    const headers = { ...authHeaders, "x-forwarded-for": "10.0.0.50" };
    const health1 = await fetch(`${limitedBase}/health`, { headers });
    expect(health1.status).toBe(200);
    const health2 = await fetch(`${limitedBase}/health`, { headers });
    expect(health2.status).toBe(429);

    const sweep1 = await fetch(`${limitedBase}/admin/sweep-expired`, {
      method: "POST",
      headers: { ...authHeaders, "x-forwarded-for": "10.0.0.50", "Content-Type": "application/json" },
      body: "{}",
    });
    const sweep2 = await fetch(`${limitedBase}/admin/sweep-expired`, {
      method: "POST",
      headers: { ...authHeaders, "x-forwarded-for": "10.0.0.50", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(sweep1.status).toBe(200);
    expect(sweep2.status).toBe(200);
  });
});
