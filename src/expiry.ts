import { recordExpiredKeyRemoved, recordSweepError } from "./metrics";
import { SweepExpiredBody } from "./schemas";
import { eKey, prefixRangeEnd, purgeExpiredPlainKey, type Store } from "./store";

const E_PREFIX = "e\x00";
const E_PREFIX_LEN = 2;
const eRangeEnd = prefixRangeEnd(E_PREFIX);

export const SWEEP_MAX_LIMIT = 1000;
export const SWEEP_DEFAULT_LIMIT = 500;

const userKeyFromEKey = (internalKey: string) => internalKey.slice(E_PREFIX_LEN);

const clampSweepLimit = (limit: number): number => {
  if (!Number.isFinite(limit) || limit <= 0) return SWEEP_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), SWEEP_MAX_LIMIT);
};

export type SweepExpiredResult = {
  cursor: string;
  removed: number;
};

export const sweepExpiredBatch =
  (store: Store) =>
  async (cursor: string, limit: number): Promise<SweepExpiredResult> => {
    const capped = clampSweepLimit(limit);
    const start = cursor === "0" ? E_PREFIX : `${eKey(cursor)}\x00`;

    const toPurge: string[] = [];
    let examined = 0;
    let lastScanned = "";
    let done = true;
    const now = Date.now();

    for (const { key, value } of store.getRange({ start, end: eRangeEnd })) {
      const userKey = userKeyFromEKey(String(key));
      lastScanned = userKey;
      examined++;

      if (value !== undefined && now >= Number(value)) toPurge.push(userKey);

      if (examined >= capped) {
        done = false;
        break;
      }
    }

    const purge = purgeExpiredPlainKey(store);
    let removed = 0;
    for (const userKey of toPurge) {
      if (await purge(userKey)) {
        removed++;
        recordExpiredKeyRemoved();
      }
    }

    return { cursor: done ? "0" : lastScanned, removed };
  };

export type StopBackgroundSweeper = () => void;

export const startBackgroundSweeper = (store: Store): StopBackgroundSweeper => {
  const intervalMs = Number(process.env.LMDIS_SWEEP_INTERVAL_MS) || 0;
  if (intervalMs <= 0) return () => {};

  const batch = clampSweepLimit(Number(process.env.LMDIS_SWEEP_BATCH));
  let cursor = "0";
  let inFlight = false;
  const sweep = sweepExpiredBatch(store);

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const result = await sweep(cursor, batch);
      cursor = result.cursor;
    } catch (e) {
      recordSweepError();
      console.error("background sweep failed:", e);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
};

export const handleSweepExpired = (store: Store) => async (req: Request): Promise<Response> => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON", code: "VALIDATION_ERROR" }, { status: 400 });
  }

  const parsed = SweepExpiredBody.safeParse(body ?? {});
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message, code: "VALIDATION_ERROR" }, { status: 400 });
  }

  const result = await sweepExpiredBatch(store)(parsed.data.cursor, parsed.data.limit);
  return Response.json(result);
};
