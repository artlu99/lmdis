import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createStore } from "../src/index";
import { iKey, resetStore } from "../src/store";
import { authHeaders, startTestServer } from "./test-helpers";

const store = createStore("data/test-keys");
const { server, base } = startTestServer(store);

const cmd = async (...args: unknown[]) => {
  const res = await fetch(base, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return { res, data: res.json() as Promise<{ result: unknown }> };
};

afterAll(() => server.stop());
beforeAll(() => resetStore(store)());

describe("KEYS", () => {
  beforeAll(async () => {
    await resetStore(store)();
    await cmd("SET", "plain:1", "v");
    await cmd("HINCR", "hash:only", "f", "1");
    await cmd("SADD", "set:only", "m");
    await cmd("SET", "session:a", "1");
    await cmd("SET", "session:b", "2");
    await cmd("SET", "other", "3");
  });

  test("returns all user keys", async () => {
    const { res, data } = await cmd("KEYS");
    expect(res.status).toBe(200);
    expect(((await data).result as string[]).sort()).toEqual(
      ["hash:only", "other", "plain:1", "session:a", "session:b", "set:only"].sort(),
    );
  });

  test("filters with MATCH glob", async () => {
    const { res, data } = await cmd("KEYS", "session:*");
    expect(res.status).toBe(200);
    expect(((await data).result as string[]).sort()).toEqual(["session:a", "session:b"]);
  });

  test("includes hash-only and set-only keys", async () => {
    const { res, data } = await cmd("KEYS", "hash:*");
    expect(res.status).toBe(200);
    expect((await data).result).toEqual(["hash:only"]);
  });

  test("returns empty list after DEL removes last data for a key", async () => {
    await cmd("SET", "temp-keys", "x");
    await cmd("DEL", "temp-keys");
    const { data } = await cmd("KEYS", "temp-keys");
    expect((await data).result).toEqual([]);
    expect(store.get(iKey("temp-keys"))).toBeUndefined();
  });
});

describe("SCANKEYS", () => {
  beforeAll(async () => {
    await resetStore(store)();
    for (let i = 0; i < 5; i++) await cmd("SET", `scan:${i}`, String(i));
  });

  test("paginates through keys", async () => {
    const page1 = await cmd("SCANKEYS", "0", 2);
    expect(page1.res.status).toBe(200);
    const [cursor1, keys1] = (await page1.data).result as [string, string[]];
    expect(keys1).toHaveLength(2);

    const page2 = await cmd("SCANKEYS", cursor1, 2);
    const [cursor2, keys2] = (await page2.data).result as [string, string[]];
    expect(keys2).toHaveLength(2);

    const page3 = await cmd("SCANKEYS", cursor2, 2);
    const [cursor3, keys3] = (await page3.data).result as [string, string[]];
    expect(keys3).toHaveLength(1);
    expect(cursor3).toBe("0");

    const all = [...keys1, ...keys2, ...keys3].sort();
    expect(all).toEqual(["scan:0", "scan:1", "scan:2", "scan:3", "scan:4"]);
  });

  test("supports MATCH filter", async () => {
    await cmd("SET", "scan:match:a", "1");
    await cmd("SET", "scan:match:b", "2");
    await cmd("SET", "scan:other", "3");

    const { data } = await cmd("SCANKEYS", "0", 100, "MATCH", "scan:match:*");
    const [cursor, keys] = (await data).result as [string, string[]];
    expect(cursor).toBe("0");
    expect(keys.sort()).toEqual(["scan:match:a", "scan:match:b"]);
  });
});

describe("index maintenance", () => {
  beforeAll(() => resetStore(store)());

  test("SDEL removes index when last member and no other data", async () => {
    await cmd("SADD", "solo-set", "only");
    expect(store.get(iKey("solo-set"))).toBeDefined();
    await cmd("SDEL", "solo-set", "only");
    expect(store.get(iKey("solo-set"))).toBeUndefined();
  });

  test("SDEL keeps index when hash data remains", async () => {
    await cmd("HINCR", "mixed", "f", "1");
    await cmd("SADD", "mixed", "m");
    await cmd("SDEL", "mixed", "m");
    expect(store.get(iKey("mixed"))).toBeDefined();
  });
});
