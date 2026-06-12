import { timingSafeEqual } from "node:crypto";

export type AuthConfig = { token: string };

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export function verifyToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const maxLen = Math.max(a.length, b.length);
  const paddedA = Buffer.alloc(maxLen);
  paddedA.set(a);
  const paddedB = Buffer.alloc(maxLen);
  paddedB.set(b);
  return timingSafeEqual(paddedA, paddedB);
}

export function authorize(req: Request, config: AuthConfig): Response | null {
  const token = extractBearerToken(req);
  if (!token) {
    return Response.json(
      { error: "Missing authorization token", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }
  if (!verifyToken(token, config.token)) {
    return Response.json(
      { error: "Invalid authorization token", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }
  return null;
}
