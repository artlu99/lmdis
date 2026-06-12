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

export const removeIfExists = (store: Store) => async (key: string) => {
  const existed = store.get(key) !== undefined;
  if (existed) await store.remove(key);
  return existed;
};
