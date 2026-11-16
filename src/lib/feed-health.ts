import { queryOptions } from "@tanstack/react-query";

import {
  getFeedHealth,
  type FeedHealthData,
  type FeedHealthRow,
  type FeedStatus,
} from "./feed-health.functions";

export type { FeedHealthData, FeedHealthRow, FeedStatus };

export const feedHealthQuery = () =>
  queryOptions({
    queryKey: ["feed-health"],
    queryFn: () => getFeedHealth(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

export const FEED_RANK: Record<FeedStatus, number> = { broken: 0, stale: 1, late: 2, live: 3 };

export const FEED_TONE: Record<FeedStatus, string> = {
  broken: "bg-destructive/15 text-destructive",
  stale: "bg-warning/15 text-warning",
  late: "bg-warning/10 text-warning",
  live: "bg-positive/15 text-positive",
};

export function feedOf(feeds: FeedHealthRow[] | undefined, feed: string): FeedHealthRow | null {
  return feeds?.find((f) => f.feed === feed) ?? null;
}

export function worstFeed(feeds: FeedHealthRow[] | undefined): FeedHealthRow | null {
  if (!feeds?.length) return null;
  return [...feeds].sort((a, b) => FEED_RANK[a.status] - FEED_RANK[b.status])[0]!;
}

export function liveCount(feeds: FeedHealthRow[] | undefined) {
  const total = feeds?.length ?? 0;
  const live = feeds?.filter((f) => f.status === "live").length ?? 0;
  const notLive = total - live;
  return { total, live, notLive };
}

/** A blocking feed that is broken means numbers are withheld, not greyed. */
export function blockingBroken(feeds: FeedHealthRow[] | undefined): FeedHealthRow[] {
  return (feeds ?? []).filter((f) => f.is_blocking && f.status === "broken");
}

/**
 * Owner rule, 19 Sep 2026: never blank a screen whose data is actually fresh.
 *
 * A run can end "thin" or late and still have written today's facts. Figures
 * are withheld ONLY when the facts themselves have not arrived — the coverage
 * edge is behind — or the last run errored outright. Everything else is said
 * out loud as a caution beside figures that still show.
 */
export function withholdingFeeds(feeds: FeedHealthRow[] | undefined): FeedHealthRow[] {
  return blockingBroken(feeds).filter((f) => {
    const lag = f.coverage_lag_days === null ? null : Number(f.coverage_lag_days);
    const dataStale = lag === null || !Number.isFinite(lag) || lag > 1;
    const runErrored = f.last_run_status === "error" || f.last_success === null;
    return dataStale || runErrored;
  });
}

/** Feeds that finished but are worth a word beside the figures. */
export function cautionFeeds(feeds: FeedHealthRow[] | undefined): FeedHealthRow[] {
  const withheld = new Set(withholdingFeeds(feeds).map((f) => f.feed));
  return (feeds ?? []).filter(
    (f) =>
      !withheld.has(f.feed) &&
      (f.status === "broken" || f.status === "stale" || f.warning_level === "warning"),
  );
}

export function feedAsAt(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}

export function feedAgeLabel(hours: number | string | null): string {
  if (hours === null || hours === undefined) return "never";
  const n = Number(hours);
  if (!Number.isFinite(n)) return "never";
  if (n < 48) return `${Math.round(n)}h`;
  return `${Math.floor(n / 24)}d ${Math.round(n % 24)}h`;
}

/** "last finished 3h ago" / "has never finished a run" — never "never ago". */
export function feedAgePhrase(hours: number | string | null): string {
  const label = feedAgeLabel(hours);
  return label === "never" ? "has never finished a run" : `last finished ${label} ago`;
}
