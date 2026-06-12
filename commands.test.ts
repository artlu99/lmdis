import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createStore } from "./index";
import { resetStore } from "./store";
import { authHeaders, startTestServer } from "./test-helpers";

const store = createStore("data/test-commands");
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
beforeAll(() => resetStore(store)());

test("SET stores a value", async () => {
  const { res, data } = await cmd("SET", "mykey", "myvalue");
  expect(res.status).toBe(200);
  expect((await data).result).toBe("OK");
});

test("GET retrieves a stored value", async () => {
  await cmd("SET", "greeting", "hello");
  const { res, data } = await cmd("GET", "greeting");
  expect(res.status).toBe(200);
  expect((await data).result).toBe("hello");
});

test("DEL removes a key", async () => {
  await cmd("SET", "temp", "x");
  const { res, data } = await cmd("DEL", "temp");
  expect(res.status).toBe(200);
  expect((await data).result).toBe(1);
});

test("HINCR increments a hash field", async () => {
  const { res, data } = await cmd("HINCR", "hincr1", "hits", "1");
  expect(res.status).toBe(200);
  expect((await data).result).toBe(1);
});

test("HINCR increments existing hash field", async () => {
  await cmd("HINCR", "hincr2", "hits", "5");
  const { res, data } = await cmd("HINCR", "hincr2", "hits", "3");
  expect(res.status).toBe(200);
  expect((await data).result).toBe(8);
});

test("SADD adds a member to a set", async () => {
  const { res, data } = await cmd("SADD", "tags", "typescript");
  expect(res.status).toBe(200);
  expect((await data).result).toBe(1);
});

test("SADD returns 0 for duplicate member", async () => {
  await cmd("SADD", "tags", "rust");
  const { res, data } = await cmd("SADD", "tags", "rust");
  expect(res.status).toBe(200);
  expect((await data).result).toBe(0);
});

test("SMEMB returns all members of a set", async () => {
  await cmd("SADD", "langs", "go");
  await cmd("SADD", "langs", "py");
  const { res, data } = await cmd("SMEMB", "langs");
  expect(res.status).toBe(200);
  expect(((await data).result as string[]).sort()).toEqual(["go", "py"]);
});

test("SDEL removes a member from a set", async () => {
  await cmd("SADD", "colors", "red");
  await cmd("SADD", "colors", "blue");
  const { res, data } = await cmd("SDEL", "colors", "red");
  expect(res.status).toBe(200);
  expect((await data).result).toBe(1);
});

test("SDEL returns 0 for missing member", async () => {
  const { res, data } = await cmd("SDEL", "emptyset", "nonexistent");
  expect(res.status).toBe(200);
  expect((await data).result).toBe(0);
});

test("DEL removes hash and set sub-keys", async () => {
  await cmd("SET", "multi", "plain");
  await cmd("HINCR", "multi", "field1", "5");
  await cmd("SADD", "multi", "member1");
  const { res, data } = await cmd("DEL", "multi");
  expect(res.status).toBe(200);
  expect((await data).result).toBe(1);
  const get1 = await cmd("GET", "multi");
  expect((await get1.data).result).toBeNull();
  const hincr = await cmd("HINCR", "multi", "field1", "1");
  expect((await hincr.data).result).toBe(1);
  const smemb = await cmd("SMEMB", "multi");
  expect((await smemb.data).result as string[]).toEqual([]);
});

test("DEL returns 0 for nonexistent key with no sub-keys", async () => {
  const { res, data } = await cmd("DEL", "never-existed");
  expect(res.status).toBe(200);
  expect((await data).result).toBe(0);
});

test("HINCR rejects non-numeric amount", async () => {
  const { res, data } = await cmd("HINCR", "hincr-nan", "hits", "abc");
  expect(res.status).toBe(400);
  const body = (await data) as unknown as { error: string; code: string };
  expect(body.code).toBe("VALIDATION_ERROR");
});

describe("error handling", () => {
  const postRaw = async (body: unknown) => {
    const res = await fetch(base, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, data: res.json() as Promise<{ error: string; code: string }> };
  };

  test("validation error returns structured { error, code }", async () => {
    const { res, data } = await postRaw(["ZPOPMEM"]);
    expect(res.status).toBe(400);
    const body = await data;
    expect(body.error).toBeDefined();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  test("invalid JSON returns structured { error, code }", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: "not json{{{",
    });
    const body = (await res.json()) as { error: string; code: string };
    expect(res.status).toBe(400);
    expect(body.error).toBeDefined();
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});
