import { globIndexRange, matchGlob } from "./glob";
import { iKey, iPrefix, prefixRangeEnd, type Store } from "./store";

const INDEX_PREFIX_LEN = 2;

export const SCANKEYS_MAX_COUNT = 1000;

const userKeyFromIndex = (indexKey: string) => indexKey.slice(INDEX_PREFIX_LEN);

const indexEnd = prefixRangeEnd(iPrefix());

type IndexRange = {
  start: string;
  /** Exclusive upper bound; omitted when `prefix` guards the block instead. */
  end?: string;
  /** User-key prefix for prefix-optimized scans (guarded in the loop). */
  prefix?: string;
  filter?: string;
};

const indexRangeForPattern = (pattern?: string): IndexRange => {
  if (!pattern) return { start: iPrefix(), end: indexEnd };
  const range = globIndexRange(pattern);
  if (range) {
    // No end bound: a `prefix + "\xff"` bound would truncate for keys with
    // chars ≥ U+0100. The loop breaks on leaving the prefix block instead.
    return { start: iKey(range.prefix), prefix: range.prefix };
  }
  return { start: iPrefix(), end: indexEnd, filter: pattern };
};

const matchesPattern = (userKey: string, filter?: string) =>
  filter === undefined || matchGlob(filter, userKey);

export const cmdKeys = (store: Store) => (pattern?: string) => {
  const { start, end, prefix, filter } = indexRangeForPattern(pattern);
  const keys: string[] = [];
  for (const { key } of store.getRange(end ? { start, end } : { start })) {
    const userKey = userKeyFromIndex(String(key));
    if (prefix !== undefined && !userKey.startsWith(prefix)) {
      if (userKey > prefix) break; // left the prefix block: scan complete
      continue; // sorts past the block only under cross-length encoding quirks
    }
    if (!matchesPattern(userKey, filter)) continue;
    keys.push(userKey);
  }
  return Response.json({ result: keys });
};

export const cmdScanKeys =
  (store: Store) => (cursor: string, count: number, pattern?: string) => {
    const capped = Math.min(count, SCANKEYS_MAX_COUNT);
    const { start: rangeStart, end, prefix, filter } = indexRangeForPattern(pattern);
    const start = cursor === "0" ? rangeStart : iKey(cursor);
    let skipFirst = cursor !== "0";

    const keys: string[] = [];
    let lastScanned = "";
    let done = true;

    for (const { key } of store.getRange(end ? { start, end } : { start })) {
      if (skipFirst) {
        skipFirst = false;
        continue;
      }
      const userKey = userKeyFromIndex(String(key));
      lastScanned = userKey;

      if (prefix !== undefined && !userKey.startsWith(prefix)) {
        if (userKey > prefix) break; // left the prefix block: scan complete
        continue;
      }

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
