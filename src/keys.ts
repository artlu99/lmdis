import { globIndexRange, matchGlob } from "./glob";
import { iKey, iPrefix, type Store } from "./store";

const INDEX_PREFIX_LEN = 2;

export const SCANKEYS_MAX_COUNT = 1000;

const userKeyFromIndex = (indexKey: string) => indexKey.slice(INDEX_PREFIX_LEN);

const indexEnd = iPrefix() + "\xff";

type IndexRange = {
  start: string;
  end: string;
  filter?: string;
};

const indexRangeForPattern = (pattern?: string): IndexRange => {
  if (!pattern) return { start: iPrefix(), end: indexEnd };
  const range = globIndexRange(pattern);
  if (range) {
    return {
      start: iKey(range.prefix),
      end: iKey(range.prefix) + "\xff",
    };
  }
  return { start: iPrefix(), end: indexEnd, filter: pattern };
};

const matchesPattern = (userKey: string, filter?: string) =>
  filter === undefined || matchGlob(filter, userKey);

export const cmdKeys = (store: Store) => (pattern?: string) => {
  const { start, end, filter } = indexRangeForPattern(pattern);
  const keys: string[] = [];
  for (const { key } of store.getRange({ start, end })) {
    const userKey = userKeyFromIndex(String(key));
    if (!matchesPattern(userKey, filter)) continue;
    keys.push(userKey);
  }
  return Response.json({ result: keys });
};

export const cmdScanKeys =
  (store: Store) => (cursor: string, count: number, pattern?: string) => {
    const capped = Math.min(count, SCANKEYS_MAX_COUNT);
    const { start: rangeStart, end, filter } = indexRangeForPattern(pattern);
    const start = cursor === "0" ? rangeStart : iKey(cursor);
    let skipFirst = cursor !== "0";

    const keys: string[] = [];
    let lastScanned = "";
    let done = true;

    for (const { key } of store.getRange({ start, end })) {
      if (skipFirst) {
        skipFirst = false;
        continue;
      }
      const userKey = userKeyFromIndex(String(key));
      lastScanned = userKey;

      if (filter && !matchGlob(filter, userKey)) continue;

      keys.push(userKey);
      if (keys.length >= capped) {
        done = false;
        break;
      }
    }

    const nextCursor = done ? "0" : lastScanned;
    return Response.json({ result: [nextCursor, keys] as [string, string[]] });
  };
