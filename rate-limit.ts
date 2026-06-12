export type RateLimitConfig = {
  maxRequests: number;
  windowMs: number;
};

export const createRateLimiter = (config: RateLimitConfig) => {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return (req: Request): Response | null => {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + config.windowMs };
      buckets.set(ip, bucket);
    }
    bucket.count++;
    if (bucket.count > config.maxRequests) {
      return Response.json(
        { error: "rate limit exceeded", code: "RATE_LIMITED" },
        { status: 429 },
      );
    }
    return null;
  };
};
