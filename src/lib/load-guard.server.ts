/**
 * LOAD PROTECTION for heavy background jobs.
 *
 * Owner-set after the 6 Sep outage: the lead backfill saturated the database
 * while the regular syncs were running, and the whole instance stopped
 * answering. Heavy jobs (lead backfill, seat recount, transcript parsing,
 * recording downloads) must therefore never run flat out.
 *
 * Four protections, all in this file so every job uses the same ones:
 *  1. batch caps — no job asks for more rows per pass than BATCH_CAP;
 *  2. inter-batch pacing — a floor on the gap between database round trips,
 *     so a job leaves headroom for the interactive screens;
 *  3. exponential backoff — transient timeouts / connection resets are retried
 *     with a widening gap rather than hammered;
 *  4. a shared circuit breaker in app_settings — once a job has exhausted its
 *     retries it trips the breaker, and EVERY heavy job then exits early with
 *     status 'skipped' until the cool-off passes. Cursors are untouched, so
 *     the next scheduled call resumes exactly where it stopped.
 *
 * Documented instance limits (Lovable Cloud small Postgres, observed):
 *  - ~60 usable connections; PgBouncer in front, so keep concurrency at 1 per job;
 *  - statement_timeout raises 57014 on wide writes past a few seconds;
 *  - the outage appeared as HTTP 521/522 from the Data API, not as SQL errors.
 */

import { getPg, pgRpc, pgSelect, pgUpsert, type PgClient } from "./pg.server";
import { safeMessage } from "./safe-error";

export const LOAD_LIMITS = {
  /** Largest number of source records a job may pull into one pass. */
  BATCH_CAP: 200,
  /** Minimum gap between successive database round trips inside a job. */
  PACE_MS: 250,
  /** Retry attempts for a transient failure before the breaker trips. */
  MAX_ATTEMPTS: 5,
  /** First backoff step; doubles each attempt. */
  BASE_BACKOFF_MS: 1000,
  /** How long every heavy job stands down once the breaker trips. */
  COOLOFF_MINUTES: 20,
} as const;

const BREAKER_KEY = "load_breaker_until";
const BREAKER_REASON_KEY = "load_breaker_reason";

export function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** A failure that means "the database is struggling", not "this data is bad". */
export function isTransient(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("57014") || // statement timeout
    msg.includes("08006") ||
    msg.includes("08003") ||
    msg.includes("53300") || // too many connections
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("connection") ||
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes(" 520") ||
    msg.includes(" 521") ||
    msg.includes(" 522") ||
    msg.includes(" 524") ||
    msg.includes("deadline exceeded")
  );
}

/** Paces a job: awaiting it never returns sooner than `minMs` after the last. */
export function makePacer(minMs: number = LOAD_LIMITS.PACE_MS): () => Promise<void> {
  let last = 0;
  return async () => {
    const wait = minMs - (Date.now() - last);
    if (wait > 0) await sleepMs(wait);
    last = Date.now();
  };
}

export class CircuitOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

/** Exponential backoff around one unit of work. Permanent errors rethrow at once. */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts: number = LOAD_LIMITS.MAX_ATTEMPTS,
): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransient(e)) throw e;
      if (i === attempts - 1) break;
      await sleepMs(LOAD_LIMITS.BASE_BACKOFF_MS * 2 ** i);
    }
  }
  throw new CircuitOpenError(
    `${label} gave up after ${attempts} attempts: ${(lastErr as Error)?.message ?? "unknown error"}`,
  );
}

export type BreakerState = { open: boolean; until: string | null; reason: string | null };

/** Reads the shared breaker. A read failure is itself treated as "stand down". */
export async function breakerState(pg?: PgClient | null): Promise<BreakerState> {
  const client = pg ?? getPg();
  if (!client) return { open: false, until: null, reason: null };
  try {
    const rows =
      (await pgSelect<{ key: string; value: string | null }[]>(
        client,
        `/app_settings?select=key,value&key=in.(${BREAKER_KEY},${BREAKER_REASON_KEY})`,
      )) ?? [];
    const until = rows.find((r) => r.key === BREAKER_KEY)?.value ?? null;
    const reason = rows.find((r) => r.key === BREAKER_REASON_KEY)?.value ?? null;
    if (!until) return { open: false, until: null, reason: null };
    return { open: new Date(until).getTime() > Date.now(), until, reason };
  } catch (e) {
    return {
      open: true,
      until: null,
      reason: `settings unreadable: ${safeMessage(e)}`,
    };
  }
}

export async function tripBreaker(
  pg: PgClient,
  reason: string,
  minutes: number = LOAD_LIMITS.COOLOFF_MINUTES,
): Promise<string> {
  const until = new Date(Date.now() + minutes * 60000).toISOString();
  try {
    await pgUpsert(pg, "app_settings", [
      { key: BREAKER_KEY, value: until, description: "Heavy jobs stand down until this time" },
      { key: BREAKER_REASON_KEY, value: reason, description: "Why heavy jobs stood down" },
    ], "key");
  } catch {
    /* the breaker is advisory; a failed write must not mask the original error */
  }
  return until;
}

export async function clearBreaker(pg: PgClient): Promise<void> {
  try {
    await pgUpsert(pg, "app_settings", [
      { key: BREAKER_KEY, value: null, description: "Heavy jobs stand down until this time" },
      { key: BREAKER_REASON_KEY, value: null, description: "Why heavy jobs stood down" },
    ], "key");
  } catch {
    /* advisory only */
  }
}

/**
 * PLANNER STATISTICS after a write.
 *
 * Owner-set after the 7 Sep outage: the lead backfill inserted ~213k rows and
 * nothing refreshed the statistics, so Postgres kept planning against the old
 * row counts, picked catastrophic plans and every dashboard read hit the
 * two-minute statement timeout. Stale statistics are therefore treated as part
 * of the job, not as maintenance someone remembers to do: every ingest calls
 * this on the tables it wrote before it reports success.
 *
 * Never fatal. A job that loaded its data correctly has succeeded even if the
 * statistics refresh could not run; the weekly maintenance job is the backstop.
 */
export async function analyzeAfterWrite(
  pg: PgClient | null | undefined,
  tables: readonly string[],
): Promise<{ analyzed: string[]; error: string | null }> {
  if (!pg || tables.length === 0) return { analyzed: [], error: null };
  const unique = [...new Set(tables)];
  try {
    await pgRpc(pg, "analyze_tables", { p_tables: unique });
    return { analyzed: unique, error: null };
  } catch (e) {
    return { analyzed: [], error: safeMessage(e) };
  }
}


/**
 * The buyer-attribution snapshot is derived from `leads`, so any job that wrote
 * leads must refresh it — otherwise /sales reads yesterday's attribution while
 * the lead table has moved on.
 */
export async function refreshLeadAttribution(
  pg: PgClient | null | undefined,
): Promise<{ ok: boolean; note: string | null }> {
  if (!pg) return { ok: false, note: null };
  try {
    const out = await pgRpc<string>(pg, "refresh_lead_attribution", {});
    return { ok: true, note: typeof out === "string" ? out : null };
  } catch (e) {
    return { ok: false, note: safeMessage(e) };
  }
}
