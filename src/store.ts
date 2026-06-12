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

export const expirePlainKeyIfNeeded = (store: Store) => async (key: string) => {
  const expiryKey = eKey(key);
  const raw = store.get(expiryKey);
  if (raw === undefined) return;
  if (Date.now() < Number(raw)) return;
  await store.transaction(async () => {
    await store.remove(key);
    await store.remove(expiryKey);
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
