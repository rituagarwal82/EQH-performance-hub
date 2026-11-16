/**
 * Date range presets for the top bar.
 *
 * Default is Last 7 days, deliberately: on the 2nd of a month a month-to-date
 * view reads as a catastrophe when nothing is wrong.
 */
export const RANGE_PRESETS = [
  "yesterday",
  "last7",
  "last14",
  "last30",
  "this_month",
  "last_month",
  "this_year",
  "custom",
] as const;

export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_LABELS: Record<RangePreset, string> = {
  yesterday: "Yesterday",
  last7: "Last 7 days",
  last14: "Last 14 days",
  last30: "Last 30 days",
  this_month: "This month",
  last_month: "Last month",
  this_year: "This year",
  custom: "Custom",
};

export const DEFAULT_PRESET: RangePreset = "last7";

export type Range = { since: string; until: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

/**
 * Ranges are resolved against "today" in UTC. The reporting day for this
 * business is IST-shifted, but Meta reports on its own account calendar and we
 * never invent a day boundary the source does not have.
 */
export function resolveRange(
  preset: RangePreset,
  custom?: { since?: string | undefined; until?: string | undefined },
  today = new Date(),
): Range {
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const yesterday = addDays(t, -1);

  switch (preset) {
    case "yesterday":
      return { since: iso(yesterday), until: iso(yesterday) };
    case "last14":
      return { since: iso(addDays(t, -14)), until: iso(yesterday) };
    case "last30":
      return { since: iso(addDays(t, -30)), until: iso(yesterday) };
    case "this_month":
      return { since: iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))), until: iso(t) };
    case "last_month": {
      const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1));
      const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0));
      return { since: iso(first), until: iso(last) };
    }
    case "this_year":
      return { since: iso(new Date(Date.UTC(t.getUTCFullYear(), 0, 1))), until: iso(t) };
    case "custom":
      return {
        since: custom?.since ?? iso(addDays(t, -7)),
        until: custom?.until ?? iso(yesterday),
      };
    case "last7":
    default:
      return { since: iso(addDays(t, -7)), until: iso(yesterday) };
  }
}

/** The immediately preceding window of identical length. */
export function priorRange(range: Range): Range {
  const since = Date.parse(range.since);
  const until = Date.parse(range.until);
  const days = Math.round((until - since) / 86400000) + 1;
  return {
    since: iso(new Date(since - days * 86400000)),
    until: iso(new Date(until - days * 86400000)),
  };
}

export function rangeLabel(preset: RangePreset, range: Range): string {
  if (preset === "custom") return `${range.since} → ${range.until}`;
  return `${RANGE_LABELS[preset]} · ${range.since} → ${range.until}`;
}
