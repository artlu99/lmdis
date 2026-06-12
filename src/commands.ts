import { CommandReq } from "./schemas";
import {
  eKey,
  expirePlainKeyIfNeeded,
  expiresAtMs,
  hKey,
  hPrefix,
  mKey,
  mPrefix,
  removeExpiryIfExists,
  removeIfExists,
  type SetTtl,
  type Store,
} from "./store";

const parseSetTtl = (args: unknown[]): SetTtl | undefined => {
  if (args.length === 3) return undefined;
  if (args.length === 4 && args[3] === "KEEPTTL") return { kind: "keepttl" };
  if (args.length === 5) {
    const opt = args[3];
    const amount = args[4] as number;
    switch (opt) {
      case "EX":
        return { kind: "ex", seconds: amount };
      case "PX":
        return { kind: "px", ms: amount };
      case "EXAT":
        return { kind: "exat", atSeconds: amount };
      case "PXAT":
        return { kind: "pxat", atMs: amount };
    }
  }
  return undefined;
};

export const cmdSet =
  (store: Store) => async (key: string, value: string, ttl?: SetTtl) => {
    await expirePlainKeyIfNeeded(store)(key);
    await store.transaction(async () => {
      await store.put(key, value);
      if (ttl === undefined) {
        await removeExpiryIfExists(store)(key);
        return;
      }
      const expiry = expiresAtMs(ttl);
      if (expiry === "keep") return;
      await store.put(eKey(key), String(expiry));
    });
    return Response.json({ result: "OK" });
  };

export const cmdGet = (store: Store) => async (key: string) => {
  await expirePlainKeyIfNeeded(store)(key);
  return Response.json({ result: store.get(key) ?? null });
};

export const cmdDel = (store: Store) => async (key: string) => {
  let removed = 0;
  await store.transaction(async () => {
    if (await removeIfExists(store)(key)) removed = 1;
    if (await removeIfExists(store)(eKey(key))) removed = 1;
    const hPre = hPrefix(key);
    for (const { key: k } of store.getRange({ start: hPre, end: hPre + "\xff" })) {
      await store.remove(k);
      removed = 1;
    }
    const mPre = mPrefix(key);
    for (const { key: k } of store.getRange({ start: mPre, end: mPre + "\xff" })) {
      await store.remove(k);
      removed = 1;
    }
  });
  return Response.json({ result: removed });
};

export const cmdHincr = (store: Store) => async (key: string, field: string, amount: string) => {
  if (!Number.isFinite(Number(amount))) {
    return Response.json({ error: "amount must be a valid number", code: "VALIDATION_ERROR" }, { status: 400 });
  }
  const k = hKey(key, field);
  let next = 0;
  await store.transaction(async () => {
    next = Number(store.get(k) ?? 0) + Number(amount);
    await store.put(k, String(next));
  });
  return Response.json({ result: next });
};

export const cmdSadd = (store: Store) => async (key: string, member: string) => {
  const k = mKey(key, member);
  let added = 0;
  await store.transaction(async () => {
    const existed = store.get(k) !== undefined;
    if (!existed) {
      await store.put(k, "");
      added = 1;
    }
  });
  return Response.json({ result: added });
};

export const cmdSmemb = (store: Store) => (key: string) => {
  const prefix = mPrefix(key);
  const members: string[] = [];
  for (const { key: k } of store.getRange({
    start: prefix,
    end: prefix + "\xff",
  })) {
    members.push(String(k).slice(prefix.length));
  }
  return Response.json({ result: members });
};

export const cmdSdel = (store: Store) => async (key: string, member: string) => {
  let removed = 0;
  await store.transaction(async () => {
    if (await removeIfExists(store)(mKey(key, member))) removed = 1;
  });
  return Response.json({ result: removed });
};

export const handleCommand = (store: Store) => async (req: Request): Promise<Response> => {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > 1_000_000) {
    return Response.json({ error: "request body too large (max 1MB)", code: "VALIDATION_ERROR" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON", code: "VALIDATION_ERROR" }, { status: 400 });
  }
  const parsed = CommandReq.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, { status: 400 });
  }
  const [cmd, ...args] = parsed.data;
  try {
    switch (cmd) {
      case "SET":
        return await cmdSet(store)(args[0]!, args[1]!, parseSetTtl(parsed.data as unknown[]));
      case "GET":
        return await cmdGet(store)(args[0]!);
      case "DEL":
        return await cmdDel(store)(args[0]!);
      case "HINCR":
        return await cmdHincr(store)(args[0]!, args[1]!, args[2]!);
      case "SADD":
        return await cmdSadd(store)(args[0]!, args[1]!);
      case "SMEMB":
        return cmdSmemb(store)(args[0]!);
      case "SDEL":
        return await cmdSdel(store)(args[0]!, args[1]!);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message, code: "INTERNAL_ERROR" }, { status: 500 });
  }
};
