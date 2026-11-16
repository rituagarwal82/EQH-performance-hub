/**
 * ONE DOOR FOR EVERY HEAVY SCHEDULED JOB.
 *
 * Owner-set after the 6/7 Sep outages: the backfill was guarded and the
 * regular syncs were not, so the instance still fell over. Load protection
 * that depends on each job's author remembering to import the guard protects
 * whatever was written before people got busy. Every job route therefore runs
 * through this wrapper, which is where the four protections actually apply:
 *
 *  - breaker check: if any heavy job has already tripped the shared breaker,
 *    this one exits immediately with status 'skipped'. Cursors untouched.
 *  - retry with backoff: transient failures (timeouts, 52x, connection resets)
 *    are retried with a widening gap instead of hammered.
 *  - breaker trip: once the retries are exhausted, EVERY heavy job stands down
 *    for the cool-off — the failure is shared, so the stand-down is shared.
 *  - honest reporting: a skip is reported as a skip, never as a success.
 */

import { getPg } from "./pg.server";
import {
  breakerState,
  CircuitOpenError,
  LOAD_LIMITS,
  tripBreaker,
  withRetry,
} from "./load-guard.server";
import { safeMessage } from "./safe-error";

export type GuardedOutcome<T> =
  | { guarded: "ran"; result: T }
  | { guarded: "skipped"; reason: string; until: string | null }
  | { guarded: "stood-down"; reason: string; until: string };

export async function runGuardedJob<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number } = {},
): Promise<GuardedOutcome<T>> {
  const pg = getPg();
  const state = await breakerState(pg);
  if (state.open) {
    return {
      guarded: "skipped",
      reason: state.reason ?? "heavy jobs are standing down after an earlier overload",
      until: state.until,
    };
  }

  try {
    // A single-attempt job still goes through withRetry so the breaker path
    // below is reachable — this is the only place CircuitOpenError is raised.
    const result = await withRetry(label, fn, opts.attempts ?? LOAD_LIMITS.MAX_ATTEMPTS);
    return { guarded: "ran", result };
  } catch (e) {
    if (e instanceof CircuitOpenError && pg) {
      const until = await tripBreaker(pg, `${label}: ${safeMessage(e)}`);
      return { guarded: "stood-down", reason: safeMessage(e), until };
    }
    throw e;
  }
}

/** Turns a guarded outcome into the HTTP answer a scheduled caller expects. */
export function guardedResponse<T extends object>(outcome: GuardedOutcome<T>): Response {
  if (outcome.guarded === "ran") {
    const body = outcome.result as T & { status?: string };
    return Response.json(body, {
      status: body.status === "error" ? 500 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (outcome.guarded === "skipped") {
    return Response.json(
      { status: "skipped", reason: outcome.reason, breaker_until: outcome.until },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { status: "error", error: outcome.reason, breaker_until: outcome.until },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
