import { open, type Database } from "lmdb";

export type Store = Database<string, string>;

export const createStore = (path = "data/lmdb"): Store =>
  open<string, string>({ path });

export const resetStore = (store: Store) => async () => {
  for (const { key } of store.getRange()) await store.remove(key);
};

export const hKey = (key: string, field: string) => `h\x00${key}\x00${field}`;
export const hPrefix = (key: string) => `h\x00${key}\x00`;
export const mKey = (key: string, member: string) => `m\x00${key}\x00${member}`;
export const mPrefix = (key: string) => `m\x00${key}\x00`;
export const eKey = (key: string) => `e\x00${key}`;
export const iKey = (key: string) => `i\x00${key}`;
export const iPrefix = () => `i\x00`;

const BACKFILL_MARKER = "__lmdis_index_backfill_v1__";
const INTERNAL_PREFIXES = ["h\x00", "m\x00", "e\x00", "i\x00"] as const;

const isInternalKey = (key: string) =>
  INTERNAL_PREFIXES.some((prefix) => key.startsWith(prefix));

const userKeyFromHKey = (key: string): string | null => {
  if (!key.startsWith("h\x00")) return null;
  const rest = key.slice(2);
  const sep = rest.indexOf("\x00");
  if (sep === -1) return null;
  return rest.slice(0, sep);
};

const userKeyFromMKey = (key: string): string | null => {
  if (!key.startsWith("m\x00")) return null;
  const rest = key.slice(2);
  const sep = rest.indexOf("\x00");
  if (sep === -1) return null;
  return rest.slice(0, sep);
};

export type SetTtl =
  | { kind: "ex"; seconds: number }
  | { kind: "px"; ms: number }
  | { kind: "exat"; atSeconds: number }
  | { kind: "pxat"; atMs: number }
  | { kind: "keepttl" };

export const expiresAtMs = (ttl: SetTtl): number | "keep" => {
  switch (ttl.kind) {
    case "ex":
      return Date.now() + ttl.seconds * 1000;
    case "px":
      return Date.now() + ttl.ms;
    case "exat":
      return ttl.atSeconds * 1000;
    case "pxat":
      return ttl.atMs;
    case "keepttl":
      return "keep";
  }
};

export const touchIndex = (store: Store) => async (userKey: string) => {
  await store.put(iKey(userKey), "");
};

export const keyHasData = (store: Store) => (userKey: string): boolean => {
  if (store.get(userKey) !== undefined) return true;
  if (store.get(eKey(userKey)) !== undefined) return true;
  const hPre = hPrefix(userKey);
  for (const _ of store.getRange({ start: hPre, end: hPre + "\xff", limit: 1 })) return true;
  const mPre = mPrefix(userKey);
  for (const _ of store.getRange({ start: mPre, end: mPre + "\xff", limit: 1 })) return true;
  return false;
};

export const syncIndex = (store: Store) => async (userKey: string) => {
  if (keyHasData(store)(userKey)) await touchIndex(store)(userKey);
  else await removeIfExists(store)(iKey(userKey));
};

export const expirePlainKeyIfNeeded = (store: Store) => async (key: string) => {
  const expiryKey = eKey(key);
  const raw = store.get(expiryKey);
  if (raw === undefined) return;
  if (Date.now() < Number(raw)) return;
  await store.transaction(async () => {
    await store.remove(key);
    await store.remove(expiryKey);
    await syncIndex(store)(key);
  });
};

export const backfillIndexIfNeeded = (store: Store) => async () => {
  if (store.get(BACKFILL_MARKER) !== undefined) return;
  await store.transaction(async () => {
    for (const { key } of store.getRange()) {
      const k = String(key);
      if (k === BACKFILL_MARKER) continue;
      if (isInternalKey(k)) {
        const userKey = userKeyFromHKey(k) ?? userKeyFromMKey(k);
        if (userKey) await store.put(iKey(userKey), "");
        continue;
      }
      await store.put(iKey(k), "");
    }
    await store.put(BACKFILL_MARKER, "");
  });
};

export const removeExpiryIfExists = (store: Store) => async (key: string) => {
  const expiryKey = eKey(key);
  if (store.get(expiryKey) !== undefined) await store.remove(expiryKey);
};

export const removeIfExists = (store: Store) => async (key: string) => {
  const existed = store.get(key) !== undefined;
  if (existed) await store.remove(key);
  return existed;
};
