/**
 * EVERY RETRY IS VISIBLE.
 *
 * Owner-set 19 Sep: a feed that only survives because it retried is a feed on
 * its way to failing. Self-healing is good; a SILENT self-heal is how the
 * ledger's busy Google Sheet and the lead sync's timeouts went unnoticed for
 * days. So every retry — successful or not — is written here, and the owner
 * screen can show "this arrived, but only on the third attempt".
 *
 * Never fatal: a failure to log a retry must never turn a recovered run into a
 * failed one.
 */

import { getPg, pgInsert } from "./pg.server";

export async function logRetry(
  source: string,
  step: string,
  attempt: number,
  reason: string,
): Promise<void> {
  try {
    const pg = getPg();
    if (!pg) return;
    await pgInsert(pg, "sync_retry_log", {
      source,
      step,
      attempt,
      reason: reason.slice(0, 500),
    });
  } catch {
    /* advisory only */
  }
}

/** Transient in the sense that waiting is the right answer. */
export function isWaitable(e: unknown): boolean {
  const m = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).toLowerCase();
  return (
    m.includes("429") ||
    m.includes("500") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("504") ||
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("57014") ||
    m.includes("unavailable") ||
    m.includes("fetch failed") ||
    m.includes("econnreset")
  );
}

/**
 * Three attempts, widening gap, every retry logged. Permanent failures (a bad
 * request, a missing sheet) rethrow at once — waiting cannot fix those.
 */
export async function withLoggedRetry<T>(
  source: string,
  step: string,
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let last: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isWaitable(e)) throw e;
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await logRetry(source, step, i + 1, reason);
      if (i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i + Math.floor(Math.random() * 500)));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
