import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "./rate-limit";

const req = (ip?: string) =>
  new Request("http://localhost/", {
    headers: ip ? { "x-forwarded-for": ip } : {},
  });

describe("createRateLimiter", () => {
  test("allows requests under the limit", () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    expect(limiter(req("1.2.3.4"))).toBeNull();
    expect(limiter(req("1.2.3.4"))).toBeNull();
  });

  test("returns 429 when limit exceeded", async () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    expect(limiter(req("5.6.7.8"))).toBeNull();
    const denied = limiter(req("5.6.7.8"));
    expect(denied?.status).toBe(429);
    const body = (await denied!.json()) as { code: string };
    expect(body.code).toBe("RATE_LIMITED");
  });

  test("tracks limits per IP independently", () => {
    const limiter = createRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    expect(limiter(req("1.1.1.1"))).toBeNull();
    expect(limiter(req("2.2.2.2"))).toBeNull();
    expect(limiter(req("1.1.1.1"))?.status).toBe(429);
  });
});
