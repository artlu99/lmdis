import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createStore } from "../src/index";
import { authHeaders, startTestServer } from "./test-helpers";

const store = createStore("data/test-schemas");
const { server, base } = startTestServer(store);

afterAll(() => server.stop());

describe("POST body validation", () => {
  const postRaw = async (body: unknown) => {
    const res = await fetch(base, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { res, data: res.json() as Promise<{ error: string }> };
  };

  test("returns 400 for unknown command", async () => {
    const { res, data } = await postRaw(["ZPOPMEM"]);
    expect(res.status).toBe(400);
    expect((await data).error).toBeDefined();
  });

  test("returns 400 for missing args (SET needs 2)", async () => {
    const { res, data } = await postRaw(["SET", "onlykey"]);
    expect(res.status).toBe(400);
    expect((await data).error).toBeDefined();
  });

  test("returns 400 for non-array body", async () => {
    const { res, data } = await postRaw("not an array");
    expect(res.status).toBe(400);
    expect((await data).error).toBeDefined();
  });

  test("returns 400 for non-string command", async () => {
    const { res, data } = await postRaw([123, "key"]);
    expect(res.status).toBe(400);
    expect((await data).error).toBeDefined();
  });

  test("returns 400 for empty array", async () => {
    const { res, data } = await postRaw([]);
    expect(res.status).toBe(400);
    expect((await data).error).toBeDefined();
  });

  test("returns 400 for empty key", async () => {
    const { res, data } = await postRaw(["GET", ""]);
    expect(res.status).toBe(400);
    expect((await data).error).toBeDefined();
  });

  test("returns 400 for key containing null byte", async () => {
    const { res, data } = await postRaw(["GET", "a\x00b"]);
    expect(res.status).toBe(400);
    expect((await data).error).toBeDefined();
  });

  test("returns 400 for non-numeric HINCR amount", async () => {
    const { res, data } = await postRaw(["HINCR", "k", "f", "nope"]);
    expect(res.status).toBe(400);
    expect((await data).error).toBeDefined();
  });
});

describe("OpenAPI spec", () => {
  let spec: Record<string, unknown>;

  beforeAll(async () => {
    const res = await fetch(`${base}/openapi.json`, { headers: authHeaders });
    spec = (await res.json()) as Record<string, unknown>;
  });

  const hasPath = (path: string) =>
    Object.keys(spec.paths as Record<string, unknown>).includes(path);

  test("does not include deprecated path routes", () => {
    const paths = Object.keys(spec.paths as Record<string, unknown>);
    for (const path of [
      "/set/{key}/{value}",
      "/get/{key}",
      "/del/{key}",
      "/hincr/{key}/{field}/{amount}",
      "/sadd/{key}/{member}",
      "/smemb/{key}",
      "/sdel/{key}/{member}",
    ]) {
      expect(paths).not.toContain(path);
    }
  });
  test("includes /health", () => expect(hasPath("/health")).toBe(true));
  test("includes /uptime", () => expect(hasPath("/uptime")).toBe(true));
  test("includes POST /", () => {
    const root = (spec.paths as Record<string, unknown>)["/"] as Record<string, unknown>;
    expect(root.post).toBeDefined();
  });
});
