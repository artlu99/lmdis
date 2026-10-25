import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createStore } from "../src/index";
import { LmdisClient, LmdisError } from "../src/sdk";
import { resetStore } from "../src/store";
import { authHeaders, startTestServer } from "./test-helpers";

const store = createStore("data/test-set-ttl");
const { server, base } = startTestServer(store);
const client = new LmdisClient({ url: base, token: "test-token" });

const cmd = async (...args: unknown[]) => {
  const res = await fetch(base, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return { res, data: res.json() as Promise<{ result: unknown; error?: string; code?: string }> };
};

afterAll(() => server.stop());
beforeAll(() => resetStore(store)());

describe("SET TTL via REST", () => {
  test("EX keeps value until expiry", async () => {
    const { res } = await cmd("SET", "ex-key", "v1", "EX", 1);
    expect(res.status).toBe(200);
    const get1 = await cmd("GET", "ex-key");
    expect((await get1.data).result).toBe("v1");
    await Bun.sleep(1100);
    const get2 = await cmd("GET", "ex-key");
    expect((await get2.data).result).toBeNull();
  });

  test("PX expires in milliseconds", async () => {
    await cmd("SET", "px-key", "fast", "PX", 50);
    expect((await (await cmd("GET", "px-key")).data).result).toBe("fast");
    await Bun.sleep(80);
    expect((await (await cmd("GET", "px-key")).data).result).toBeNull();
  });

  test("SET without TTL clears a previous TTL", async () => {
    await cmd("SET", "clear-ttl", "a", "EX", 1);
    await cmd("SET", "clear-ttl", "b");
    await Bun.sleep(1100);
    expect((await (await cmd("GET", "clear-ttl")).data).result).toBe("b");
  });

  test("KEEPTTL preserves remaining TTL when updating value", async () => {
    await cmd("SET", "keep", "a", "EX", 2);
    await Bun.sleep(500);
    await cmd("SET", "keep", "b", "KEEPTTL");
    expect((await (await cmd("GET", "keep")).data).result).toBe("b");
    await Bun.sleep(1600);
    expect((await (await cmd("GET", "keep")).data).result).toBeNull();

    await cmd("SET", "keep2", "a", "EX", 2);
    await cmd("SET", "keep2", "b", "KEEPTTL");
    expect((await (await cmd("GET", "keep2")).data).result).toBe("b");
  });

  test("EXAT expires at unix timestamp in seconds", async () => {
    const at = Math.floor(Date.now() / 1000) + 1;
    await cmd("SET", "exat-key", "x", "EXAT", at);
    expect((await (await cmd("GET", "exat-key")).data).result).toBe("x");
    await Bun.sleep(1100);
    expect((await (await cmd("GET", "exat-key")).data).result).toBeNull();
  });

  test("PXAT expires at unix timestamp in milliseconds", async () => {
    // Generous margins: the first GET must land inside the validity window,
    // which is impossible to guarantee with tight (tens-of-ms) deadlines
    // under load — see the EXAT test for the same pattern.
    const at = Date.now() + 400;
    await cmd("SET", "pxat-key", "x", "PXAT", at);
    expect((await (await cmd("GET", "pxat-key")).data).result).toBe("x");
    await Bun.sleep(600);
    expect((await (await cmd("GET", "pxat-key")).data).result).toBeNull();
  });

  test("rejects invalid EX amount", async () => {
    const { res, data } = await cmd("SET", "bad", "v", "EX", 0);
    expect(res.status).toBe(400);
    expect((await data).code).toBe("VALIDATION_ERROR");
  });

  test("DEL removes TTL metadata", async () => {
    await cmd("SET", "del-ttl", "v", "EX", 60);
    await cmd("DEL", "del-ttl");
    expect((await (await cmd("GET", "del-ttl")).data).result).toBeNull();
  });
});

describe("SET TTL via SDK", () => {
  test("set with ex option", async () => {
    await client.set("sdk-ex", "hi", { ex: 1 });
    expect(await client.get<string>("sdk-ex")).toBe("hi");
    await Bun.sleep(1100);
    expect(await client.get<string>("sdk-ex")).toBeNull();
  });

  test("set with px and keepTtl options", async () => {
    await client.set("sdk-px", "a", { px: 2000 });
    await client.set("sdk-px", "b", { keepTtl: true });
    expect(await client.get<string>("sdk-px")).toBe("b");
  });

  test("still rejects nx, xx, and get options", async () => {
    await expect(client.set("k", "v", { nx: true })).rejects.toThrow(LmdisError);
    await expect(client.set("k", "v", { xx: true })).rejects.toThrow(LmdisError);
    await expect(client.set("k", "v", { get: true })).rejects.toThrow(LmdisError);
  });
});
