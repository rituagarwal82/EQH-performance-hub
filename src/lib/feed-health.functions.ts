import { createServerFn } from "@tanstack/react-start";

/**
 * Per-feed health, computed on the server in the same request as the data.
 *
 * Four states, and BOTH clocks matter: how long since a run succeeded, and how
 * far the actual facts reach. A sync can succeed and return nothing — the
 * coverage edge is the one that catches that.
 */
export type FeedStatus = "live" | "late" | "stale" | "broken";

export type FeedHealthRow = {
  feed: string;
  label: string;
  cadence_hours: number | string;
  is_blocking: boolean;
  last_success: string | null;
  last_run: string | null;
  last_run_status: string | null;
  running_since: string | null;
  hours_since_success: number | string | null;
  coverage_edge: string | null;
  coverage_lag_days: number | string | null;
  consecutive_failures: number;
  last_error: string | null;
  status: FeedStatus;
  rows_last_run: number | null;
  /** Meta access-token expiry warning, in the owner's own words. */
  warning: string | null;
  warning_level: "warning" | "critical" | null;
  expires_at: string | null;
  days_to_expiry: number | null;
};

export type FeedHealthData = {
  configured: boolean;
  checkedAt: string;
  feeds: FeedHealthRow[];
  error: string | null;
};

export async function readFeedHealth(): Promise<FeedHealthData> {
  const { getPg, pgRpc } = await import("./pg.server");
  const empty: FeedHealthData = {
    configured: false,
    checkedAt: new Date().toISOString(),
    feeds: [],
    error: null,
  };
  const pg = getPg();
  if (!pg) return empty;
  try {
    const feeds = await pgRpc<FeedHealthRow[]>(pg, "feed_health_rows", {});
    return {
      configured: true,
      checkedAt: new Date().toISOString(),
      feeds: feeds ?? [],
      error: null,
    };
  } catch (error) {
    return {
      ...empty,
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const getFeedHealth = createServerFn({ method: "GET" }).handler(readFeedHealth);
