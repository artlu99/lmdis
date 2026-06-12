/**
 * Example LmdisClient usage. Requires a running lmdis server.
 *
 *   bun start   # in another terminal, with LMDIS_REST_TOKEN in .env
 *   bun examples/client.ts
 *
 * Copy src/sdk.ts into your project, or run from a clone:
 *   import { LmdisClient } from "../src/sdk";
 *
 * Env: LMDIS_URL (default http://localhost:3000), LMDIS_REST_TOKEN (required)
 */
import { LmdisClient } from "../src/sdk";

export type ClientExampleResult = {
  greeting: string | null;
  counter: { count: number } | null;
  pageViews: number;
  tagsAfterSadd: string[];
  sremCount: number;
  tagsAfterSrem: string[];
  delCount: number;
};

/** Demo sequence used by examples/client.ts — strings, JSON, hashes, sets, cleanup. */
export async function runClientExample(redis: LmdisClient): Promise<ClientExampleResult> {
  await redis.set("greeting", "hello");
  const greeting = await redis.get<string>("greeting");

  await redis.set("counter", { count: 1 });
  const counter = await redis.get<{ count: number }>("counter");

  const pageViews = await redis.hincrby("page", "views", 1);

  await redis.sadd("tags", "bun", "typescript");
  const tagsAfterSadd = await redis.smembers("tags");
  const sremCount = await redis.srem("tags", "bun");
  const tagsAfterSrem = await redis.smembers("tags");

  const delCount = await redis.del("greeting", "counter", "page", "tags");

  return {
    greeting,
    counter,
    pageViews,
    tagsAfterSadd,
    sremCount,
    tagsAfterSrem,
    delCount,
  };
};

export function formatClientExampleOutput(result: ClientExampleResult): string {
  return [
    `GET greeting: ${result.greeting}`,
    `GET counter: ${JSON.stringify(result.counter)}`,
    `HINCR page:views: ${result.pageViews}`,
    `SMEMB tags: ${JSON.stringify(result.tagsAfterSadd.sort())}`,
    `SREM tags bun: ${result.sremCount}`,
    `SMEMB tags: ${JSON.stringify(result.tagsAfterSrem)}`,
    `DEL greeting: ${result.delCount}`,
  ].join("\n");
}

async function main() {
  const url = process.env.LMDIS_URL ?? "http://localhost:3000";
  const token = process.env.LMDIS_REST_TOKEN;
  if (!token) {
    console.error("LMDIS_REST_TOKEN is required");
    process.exit(1);
  }

  const redis = new LmdisClient({ url, token });
  const result = await runClientExample(redis);
  console.log(formatClientExampleOutput(result));
}

if (import.meta.main) {
  await main();
}
