import { createDocument } from "zod-openapi";
import { z } from "zod";

const noNullByte = (s: string) => !s.includes("\x00");
const userKey = z.string().min(1).refine(noNullByte, "must not contain null bytes");
const userField = userKey;
const userMember = userKey;
const incrAmount = z.string().refine((s) => Number.isFinite(Number(s)), "amount must be a valid number");

const ttlDuration = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "number" ? v : Number(v)))
  .pipe(z.number().int().positive());

const ttlTimestamp = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "number" ? v : Number(v)))
  .pipe(z.number().int().positive());

export const SetReq = z.union([
  z.tuple([z.literal("SET"), userKey, z.string()]),
  z.tuple([z.literal("SET"), userKey, z.string(), z.literal("EX"), ttlDuration]),
  z.tuple([z.literal("SET"), userKey, z.string(), z.literal("PX"), ttlDuration]),
  z.tuple([z.literal("SET"), userKey, z.string(), z.literal("EXAT"), ttlTimestamp]),
  z.tuple([z.literal("SET"), userKey, z.string(), z.literal("PXAT"), ttlTimestamp]),
  z.tuple([z.literal("SET"), userKey, z.string(), z.literal("KEEPTTL")]),
]);
export const GetReq = z.tuple([z.literal("GET"), userKey]);
export const DelReq = z.tuple([z.literal("DEL"), userKey]);
export const HincrReq = z.tuple([z.literal("HINCR"), userKey, userField, incrAmount]);
export const SaddReq = z.tuple([z.literal("SADD"), userKey, userMember]);
export const SmembReq = z.tuple([z.literal("SMEMB"), userKey]);
export const SdelReq = z.tuple([z.literal("SDEL"), userKey, userMember]);
const globPattern = z.string().min(1);
const scanCount = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "number" ? v : Number(v)))
  .pipe(z.number().int().positive().max(1000));
export const KeysReq = z.union([
  z.tuple([z.literal("KEYS")]),
  z.tuple([z.literal("KEYS"), globPattern]),
]);
export const ScanKeysReq = z.union([
  z.tuple([z.literal("SCANKEYS"), z.string(), scanCount]),
  z.tuple([z.literal("SCANKEYS"), z.string(), scanCount, z.literal("MATCH"), globPattern]),
]);
export const CommandReq = z.union([
  SetReq,
  GetReq,
  DelReq,
  HincrReq,
  SaddReq,
  SmembReq,
  SdelReq,
  KeysReq,
  ScanKeysReq,
]);

export const SetRes = z.object({ result: z.literal("OK") });
export const GetRes = z.object({ result: z.string().nullable() });
export const IntFlagRes = z.object({ result: z.union([z.literal(0), z.literal(1)]) });
export const HincrRes = z.object({ result: z.number() });
export const SmembRes = z.object({ result: z.array(z.string()) });
export const KeysRes = z.object({ result: z.array(userKey) });
export const ScanKeysRes = z.object({
  result: z.tuple([z.string(), z.array(userKey)]),
});
const UnauthorizedRes = z.object({
  error: z.string(),
  code: z.literal("UNAUTHORIZED"),
});

const oasResponse = (schema: z.ZodTypeAny) => ({
  "200": {
    description: "OK",
    content: { "application/json": { schema } },
  },
});

const protectedResponses = (schema: z.ZodTypeAny) => ({
  ...oasResponse(schema),
  "401": {
    description: "Unauthorized",
    content: { "application/json": { schema: UnauthorizedRes } },
  },
});

const bearerSecurity = [{ bearerAuth: [] }];

export const spec = createDocument({
  openapi: "3.1.0",
  info: { title: "lmdis", version: "1.0.0" },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
      },
    },
  },
  paths: {
    "/": {
      summary: "Execute command",
      post: {
        security: bearerSecurity,
        requestBody: {
          content: { "application/json": { schema: CommandReq } },
        },
        responses: protectedResponses(
          z.union([SetRes, GetRes, IntFlagRes, HincrRes, SmembRes, KeysRes, ScanKeysRes]),
        ),
      },
    },
    "/openapi.json": {
      get: {
        summary: "OpenAPI spec",
        responses: oasResponse(z.any()),
      },
    },
    "/docs": {
      get: {
        summary: "API documentation",
        responses: oasResponse(z.any()),
      },
    },
    "/health": {
      get: {
        summary: "Health check",
        responses: oasResponse(z.object({ status: z.literal("ok") })),
      },
    },
    "/uptime": {
      get: {
        security: bearerSecurity,
        summary: "Server uptime",
        responses: protectedResponses(z.object({ uptimeSeconds: z.number() })),
      },
    },
  },
});

export const docsHtml = `<!DOCTYPE html>
<html><head><title>lmdis docs</title></head>
<body><script id="api-reference" data-url="/openapi.json" data-configuration='{"showDeveloperTools":"never"}'></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script></body></html>`;
