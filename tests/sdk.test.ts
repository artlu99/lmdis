import { afterAll, beforeAll, expect, test } from "bun:test";
import { createStore } from "../src/index";
import { LmdisClient, LmdisError } from "../src/sdk";
import { resetStore } from "../src/store";
import { startTestServer } from "./test-helpers";

const store = createStore("data/test-sdk");
const { server, base } = startTestServer(store);
const client = new LmdisClient({
  url: base,
  token: "test-token",
});

afterAll(() => server.stop());
beforeAll(() => resetStore(store)());

test("set and get string values", async () => {
  expect(await client.set("greeting", "hello")).toBe("OK");
  expect(await client.get<string>("greeting")).toBe("hello");
});

test("set and get JSON values", async () => {
  await client.set("obj", { name: "joe" });
  expect(await client.get<{ name: string }>("obj")).toEqual({ name: "joe" });
});

test("get returns null for missing key", async () => {
  expect(await client.get<string>("missing")).toBeNull();
});

test("del removes keys", async () => {
  await client.set("temp", "x");
  expect(await client.del("temp")).toBe(1);
  expect(await client.get<string>("temp")).toBeNull();
});

test("hincrby increments hash fields", async () => {
  expect(await client.hincrby("hits", "page", 1)).toBe(1);
  expect(await client.hincrby("hits", "page", 4)).toBe(5);
});

test("sadd, smembers, and srem", async () => {
  expect(await client.sadd("tags", "go", "py")).toBe(2);
  expect(await client.sadd("tags", "go")).toBe(0);
  expect((await client.smembers("tags")).sort()).toEqual(["go", "py"]);
  expect(await client.srem("tags", "go")).toBe(1);
  expect(await client.smembers("tags")).toEqual(["py"]);
});

test("set rejects unsupported options", async () => {
  await expect(client.set("k", "v", { ex: 60 })).rejects.toThrow(LmdisError);
});

test("throws on unauthorized requests", async () => {
  const bad = new LmdisClient({ url: base, token: "wrong" });
  await expect(bad.get<string>("k")).rejects.toThrow(LmdisError);
});
