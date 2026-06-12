import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  formatClientExampleOutput,
  runClientExample,
  type ClientExampleResult,
} from "../../examples/client";
import { createStore } from "../../src/index";
import { LmdisClient } from "../../src/sdk";
import { resetStore } from "../../src/store";
import { startTestServer, TEST_TOKEN } from "../test-helpers";

const store = createStore("data/test-example-client");
const { server, base } = startTestServer(store);
const client = new LmdisClient({ url: base, token: TEST_TOKEN });
const exampleScript = join(import.meta.dir, "../../examples/client.ts");

afterAll(() => server.stop());
beforeAll(() => resetStore(store)());

const expectedResult = (): ClientExampleResult => ({
  greeting: "hello",
  counter: { count: 1 },
  pageViews: 1,
  tagsAfterSadd: ["bun", "typescript"],
  sremCount: 1,
  tagsAfterSrem: ["typescript"],
  delCount: 4,
});

describe("runClientExample", () => {
  beforeAll(() => resetStore(store)());

  test("returns expected values for strings, JSON, hashes, and sets", async () => {
    const result = await runClientExample(client);
    expect(result.greeting).toBe("hello");
    expect(result.counter).toEqual({ count: 1 });
    expect(result.pageViews).toBe(1);
    expect(result.tagsAfterSadd.sort()).toEqual(["bun", "typescript"]);
    expect(result.sremCount).toBe(1);
    expect(result.tagsAfterSrem).toEqual(["typescript"]);
    expect(result.delCount).toBe(4);
  });

  test("cleans up all keys after completion", async () => {
    await runClientExample(client);
    expect(await client.get<string>("greeting")).toBeNull();
    expect(await client.get<{ count: number }>("counter")).toBeNull();
    expect(await client.smembers("tags")).toEqual([]);
    expect(await client.hincrby("page", "views", 0)).toBe(0);
  });

  test("can run twice in a row with the same results", async () => {
    expect(await runClientExample(client)).toMatchObject(expectedResult());
    expect(await runClientExample(client)).toMatchObject(expectedResult());
  });

  test("hincrby accumulates when key is not deleted between runs", async () => {
    await resetStore(store)();
    await client.set("greeting", "hello");
    await client.hincrby("page", "views", 1);
    await client.hincrby("page", "views", 2);
    expect(await client.hincrby("page", "views", 0)).toBe(3);
  });
});

describe("formatClientExampleOutput", () => {
  test("formats stable console output", () => {
    const output = formatClientExampleOutput({
      greeting: "hello",
      counter: { count: 1 },
      pageViews: 1,
      tagsAfterSadd: ["typescript", "bun"],
      sremCount: 1,
      tagsAfterSrem: ["typescript"],
      delCount: 4,
    });
    expect(output).toBe(
      [
        "GET greeting: hello",
        'GET counter: {"count":1}',
        "HINCR page:views: 1",
        'SMEMB tags: ["bun","typescript"]',
        "SREM tags bun: 1",
        'SMEMB tags: ["typescript"]',
        "DEL greeting: 4",
      ].join("\n"),
    );
  });
});

describe("examples/client.ts CLI", () => {
  const runScript = (env: Record<string, string | undefined>) => {
    const merged = { ...process.env, ...env };
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete merged[key];
    }
    return Bun.spawn(["bun", exampleScript], {
      env: merged,
      stdout: "pipe",
      stderr: "pipe",
    });
  };

  beforeAll(() => resetStore(store)());

  test("exits 0 and prints expected output when configured", async () => {
    const proc = runScript({ LMDIS_URL: base, LMDIS_REST_TOKEN: TEST_TOKEN });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe(formatClientExampleOutput(expectedResult()));
  });

  test("honors LMDIS_URL for server address", async () => {
    const proc = runScript({ LMDIS_URL: base, LMDIS_REST_TOKEN: TEST_TOKEN });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain("GET greeting: hello");
  });

  test("defaults to http://localhost:3000 when LMDIS_URL is unset", async () => {
    const proc = runScript({ LMDIS_REST_TOKEN: TEST_TOKEN });
    expect(await proc.exited).not.toBe(0);
  });

  test("exits 1 when LMDIS_REST_TOKEN is missing", async () => {
    const proc = runScript({ LMDIS_URL: base, LMDIS_REST_TOKEN: "" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr.trim()).toBe("LMDIS_REST_TOKEN is required");
  });

  test("exits non-zero on auth failure", async () => {
    const proc = runScript({ LMDIS_URL: base, LMDIS_REST_TOKEN: "wrong-token" });
    expect(await proc.exited).not.toBe(0);
  });

  test("leaves store empty after subprocess run", async () => {
    await resetStore(store)();
    const proc = runScript({ LMDIS_URL: base, LMDIS_REST_TOKEN: TEST_TOKEN });
    expect(await proc.exited).toBe(0);
    expect(await client.get<string>("greeting")).toBeNull();
    expect(await client.smembers("tags")).toEqual([]);
  });
});
