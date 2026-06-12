import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createStore } from "./index";
import { hKey, mKey, resetStore } from "./store";
import { authHeaders, startTestServer } from "./test-helpers";

const store = createStore("data/test-store");
const { server, base } = startTestServer(store);

const cmd = async (...args: [string, ...string[]]) => {
  const res = await fetch(base, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return { res, data: res.json() as Promise<{ result: unknown }> };
};

afterAll(() => server.stop());

describe("key collision resistance", () => {
  beforeAll(() => resetStore(store)());

  test("hash keys containing : don't collide", async () => {
    await cmd("HINCR", "a:b", "c", "1");
    await cmd("HINCR", "a", "b:c", "1");
    const { res, data } = await cmd("HINCR", "a:b", "c", "1");
    expect(res.status).toBe(200);
    expect((await data).result).toBe(2);
  });

  test("set keys containing : don't collide", async () => {
    await cmd("SADD", "x:y", "m1");
    await cmd("SADD", "x", "y:m1");
    const { res, data } = await cmd("SMEMB", "x:y");
    expect(res.status).toBe(200);
    expect(((await data).result as string[]).sort()).toEqual(["m1"]);
  });

  test("set members containing : don't collide", async () => {
    await cmd("SADD", "s1", "a:b");
    await cmd("SADD", "s1", "a");
    const { res, data } = await cmd("SDEL", "s1", "a");
    expect(res.status).toBe(200);
    expect((await data).result).toBe(1);
    const { data: data2 } = await cmd("SMEMB", "s1");
    expect(((await data2).result as string[]).sort()).toEqual(["a:b"]);
  });
});

describe("resetStore empties all keys", () => {
  beforeAll(async () => {
    await resetStore(store)();
    for (let i = 0; i < 50; i++) await store.put(`plain:${i}`, `v${i}`);
    for (let i = 0; i < 30; i++) await store.put(hKey(`hash:${i}`, "field"), `${i}`);
    for (let i = 0; i < 25; i++) await store.put(mKey(`set:${i}`, `member${i}`), "1");
  });

  test("store has entries before reset", () => {
    const count = [...store.getRange({ start: "", end: "\xff\xff" })].length;
    expect(count).toBe(105);
  });

  test("all keys removed after resetStore", async () => {
    await resetStore(store)();
    const remaining = [...store.getRange({ start: "", end: "\xff\xff" })];
    expect(remaining).toHaveLength(0);
  });
});
