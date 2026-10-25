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

export const countLogicalKeys = (store: Store) => (): number => {
  let count = 0;
  const prefix = iPrefix();
  for (const _ of store.getRange({ start: prefix, end: prefixRangeEnd(prefix) })) count++;
  return count;
};

/**
 * Exclusive upper bound for a range over `prefix`-prefixed internal keys.
 *
 * The prefix successor (`"e\x00"` → `"e\x01"`) sorts strictly after every
 * `prefix`-prefixed key, because ordered-binary encodes `\x00` as `04 00`:
 * all `"X\x00…"` keys start with bytes `58 04 00` and the bound is `58 04 01`.
 * Do NOT use `prefix + "\xff"` — user keys may contain chars ≥ U+0100
 * (UTF-8 bytes above `\xff`-as-U+00FF), which fall outside that bound.
 */
export const prefixRangeEnd = (prefix: string): string => prefix.slice(0, 1) + "\x01";

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
  // Single materialized entry (limit: 1) + startsWith check: a `prefix + "\xff"`
  // end bound would truncate for fields/members containing chars ≥ U+0100,
  // and an unbounded live cursor abandoned via break can wedge the reader.
  for (const prefix of [hPrefix(userKey), mPrefix(userKey)]) {
    for (const { key } of store.getRange({ start: prefix, limit: 1 })) {
      if (String(key).startsWith(prefix)) return true;
    }
  }
  return false;
};

export const syncIndex = (store: Store) => async (userKey: string) => {
  if (keyHasData(store)(userKey)) await touchIndex(store)(userKey);
  else await removeIfExists(store)(iKey(userKey));
};

export const purgeExpiredPlainKey = (store: Store) => async (key: string): Promise<boolean> => {
  const expiryKey = eKey(key);
  const raw = store.get(expiryKey);
  if (raw === undefined) return false;
  if (Date.now() < Number(raw)) return false;

  // Re-check expiry inside the transaction so a concurrent SET that renews
  // the key between scan and purge cannot be deleted.
  let removed = false;
  await store.transaction(async () => {
    const current = store.get(expiryKey);
    if (current === undefined) return;
    if (Date.now() < Number(current)) return;
    await store.remove(key);
    await store.remove(expiryKey);
    await syncIndex(store)(key);
    removed = true;
  });
  return removed;
};

export const expirePlainKeyIfNeeded = (store: Store) => async (key: string): Promise<boolean> =>
  purgeExpiredPlainKey(store)(key);

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
