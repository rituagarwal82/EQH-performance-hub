import { queryOptions } from "@tanstack/react-query";

import { getSyncHealth, type SyncHealthData, type SyncHealthRow, type SyncStatus } from "./sync-health.functions";

export const syncHealthQuery = () =>
  queryOptions({
    queryKey: ["sync-health"],
    queryFn: () => getSyncHealth(),
    // Health that is itself stale is worthless.
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

const RANK: Record<SyncStatus, number> = { dead: 0, late: 1, ok: 2 };

/** The banner reads the WORST source, never an average. */
export function worstSource(data: SyncHealthData | undefined): SyncHealthRow | null {
  if (!data?.sources.length) return null;
  return [...data.sources].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || Number(b.hours_since_success ?? 1e9) - Number(a.hours_since_success ?? 1e9),
  )[0]!;
}

export function sourceHealth(
  data: SyncHealthData | undefined,
  source: string,
): SyncHealthRow | null {
  return data?.sources.find((s) => s.source === source) ?? null;
}

/** "26 Aug" — the day the figure is actually true as at. */
export function asAtLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

export function hoursLabel(hours: number | string | null): string {
  if (hours === null || hours === undefined) return "never";
  const n = Number(hours);
  if (!Number.isFinite(n)) return "never";
  if (n < 48) return `${Math.round(n)}h`;
  return `${Math.floor(n / 24)}d ${Math.round(n % 24)}h`;
}
