import { recordCommand, recordExpiredKeyRemoved } from "./metrics";
import { CommandReq } from "./schemas";
import { cmdKeys, cmdScanKeys } from "./keys";
import {
  eKey,
  expirePlainKeyIfNeeded,
  expiresAtMs,
  hKey,
  hPrefix,
  iKey,
  mKey,
  mPrefix,
  removeExpiryIfExists,
  removeIfExists,
  syncIndex,
  touchIndex,
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

const trackCommand = async (command: string, res: Response) => {
  if (res.status >= 400) {
    try {
      const body = (await res.clone().json()) as { code?: string };
      recordCommand(command, res.status, body.code ?? "UNKNOWN");
    } catch {
      recordCommand(command, res.status, "UNKNOWN");
    }
  } else {
    recordCommand(command, res.status);
  }
  return res;
};

export const cmdSet =
  (store: Store) => async (key: string, value: string, ttl?: SetTtl) => {
    if (await expirePlainKeyIfNeeded(store)(key)) recordExpiredKeyRemoved();
    await store.transaction(async () => {
      await store.put(key, value);
      await touchIndex(store)(key);
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
  if (await expirePlainKeyIfNeeded(store)(key)) recordExpiredKeyRemoved();
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
    if (await removeIfExists(store)(iKey(key))) removed = 1;
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
    await touchIndex(store)(key);
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
    await touchIndex(store)(key);
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
    await syncIndex(store)(key);
  });
  return Response.json({ result: removed });
};

export const handleCommand = (store: Store) => async (req: Request): Promise<Response> => {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > 1_000_000) {
    return trackCommand(
      "unknown",
      Response.json({ error: "request body too large (max 1MB)", code: "VALIDATION_ERROR" }, { status: 413 }),
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return trackCommand(
      "unknown",
      Response.json({ error: "invalid JSON", code: "VALIDATION_ERROR" }, { status: 400 }),
    );
  }
  const parsed = CommandReq.safeParse(body);
  if (!parsed.success) {
    return trackCommand(
      "unknown",
      Response.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, { status: 400 }),
    );
  }
  const data = parsed.data;
  const command = data[0];
  try {
    switch (command) {
      case "SET":
        return trackCommand(command, await cmdSet(store)(data[1], data[2], parseSetTtl(data as unknown[])));
      case "GET":
        return trackCommand(command, await cmdGet(store)(data[1]));
      case "DEL":
        return trackCommand(command, await cmdDel(store)(data[1]));
      case "HINCR":
        return trackCommand(command, await cmdHincr(store)(data[1], data[2], data[3]));
      case "SADD":
        return trackCommand(command, await cmdSadd(store)(data[1], data[2]));
      case "SMEMB":
        return trackCommand(command, cmdSmemb(store)(data[1]));
      case "SDEL":
        return trackCommand(command, await cmdSdel(store)(data[1], data[2]));
      case "KEYS":
        return trackCommand(command, cmdKeys(store)(data.length === 2 ? data[1] : undefined));
      case "SCANKEYS": {
        const pattern = data.length === 5 && data[3] === "MATCH" ? data[4] : undefined;
        return trackCommand(command, cmdScanKeys(store)(data[1], data[2], pattern));
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return trackCommand(
      command,
      Response.json({ error: message, code: "INTERNAL_ERROR" }, { status: 500 }),
    );
  }
};
