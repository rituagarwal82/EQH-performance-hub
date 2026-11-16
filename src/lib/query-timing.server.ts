/**
 * SELF-REPORTED SLOWNESS.
 *
 * Owner-set after the 7 Sep outage: the system must notice its own
 * degradation before the owner meets a timeout banner. Every main dashboard
 * read is timed; anything past the threshold raises one review item per day
 * per query, so a query drifting from 0.3s to 40s is reported while it is
 * still answering.
 *
 * Never fatal, never blocking: the timing write is fire-and-forget and a
 * failure to record slowness must not turn a slow screen into a broken one.
 */

import { getPg, pgInsert, pgSelect, type PgClient } from "./pg.server";

/** Past this, a dashboard read is considered degraded rather than merely busy. */
export const SLOW_QUERY_MS = 10_000;

async function raiseSlowItem(pg: PgClient, label: string, ms: number): Promise<void> {
  const refId = `query-slow:${label}`;
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const existing =
    (await pgSelect<{ id: string }[]>(
      pg,
      `/review_items?select=id&ref_id=eq.${encodeURIComponent(refId)}&status=eq.open&created_at=gte.${since}&limit=1`,
    ).catch(() => [])) ?? [];
  if (existing.length > 0) return;
  await pgInsert(pg, "review_items", {
    kind: "performance",
    ref_id: refId,
    title: `Query slow — ${label} took ${(ms / 1000).toFixed(1)}s`,
    detail:
      "A main dashboard read exceeded the 10-second guard. Usual cause is stale planner statistics after a bulk load, or a missing index. Check ANALYZE freshness on the tables it reads, then the query plan.",
    evidence: { label, duration_ms: Math.round(ms), threshold_ms: SLOW_QUERY_MS },
    status: "open",
  });
}

/** Times one unit of work and reports it when it crosses the guard. */
export async function timedQuery<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - t0;
    if (ms > SLOW_QUERY_MS) void reportIfSlow(label, ms);
  }
}

// The reporter writes to the database itself. Without this latch a slow write
// would report its own slowness, forever.
let reporting = false;

/**
 * Called from the database layer for EVERY round trip, so no query can be
 * added later and quietly escape the guard.
 */
export async function reportIfSlow(path: string, ms: number): Promise<void> {
  if (ms <= SLOW_QUERY_MS || reporting) return;
  // "/rpc/metric_components" and "/leads?select=..." both collapse to a stable
  // label, so one drifting query raises one item, not one per parameter set.
  const label = path.startsWith("/rpc/")
    ? path.slice(5).split("?")[0]!
    : path.replace(/^\//, "").split("?")[0]!;
  if (label === "review_items" || label === "app_settings") return;
  console.warn(`[EQH] slow query ${label}: ${ms}ms`);
  const pg = getPg();
  if (!pg) return;
  reporting = true;
  try {
    await raiseSlowItem(pg, label, ms);
  } catch {
    /* never fatal: a slow screen must not become a broken one */
  } finally {
    reporting = false;
  }
}

