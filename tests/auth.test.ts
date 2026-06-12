import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createStore } from "../src/index";
import { resetStore } from "../src/store";
import { authHeaders, startTestServer } from "./test-helpers";

const store = createStore("data/test-auth");
const { server, base } = startTestServer(store);

afterAll(() => server.stop());
beforeAll(() => resetStore(store)());

const post = (headers: Record<string, string>, body: unknown) =>
  fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("missing Authorization header returns 401", async () => {
  const res = await post({}, ["GET", "key"]);
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string; code: string };
  expect(body.code).toBe("UNAUTHORIZED");
});

test("wrong token returns 401", async () => {
  const res = await post({ Authorization: "Bearer wrong-token" }, ["GET", "key"]);
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string; code: string };
  expect(body.code).toBe("UNAUTHORIZED");
});

test("malformed Authorization header returns 401", async () => {
  const res = await post({ Authorization: "NotBearer token" }, ["GET", "key"]);
  expect(res.status).toBe(401);
});

test("valid token on data route returns 200", async () => {
  const res = await post(authHeaders, ["SET", "authkey", "val"]);
  expect(res.status).toBe(200);
});

test("GET /health without token returns 200", async () => {
  const res = await fetch(`${base}/health`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe("ok");
});

test("GET /uptime without token returns 401", async () => {
  const res = await fetch(`${base}/uptime`);
  expect(res.status).toBe(401);
});
