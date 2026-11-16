import type { Range } from "./date-range";

/**
 * Range clipping.
 *
 * A window that asks for seven days and receives four does not report a
 * collapse — it reports four days. The screen must say so, and every delta
 * must be computed against a window of the SAME clipped length, never the
 * length that was requested.
 */

export type BlockingFeed = "meta" | "ledger";

export type DayCoverageRow = {
  date: string;
  meta_rows: number | string;
  ledger_rows: number | string;
  zoom_rows: number | string;
  leads_rows: number | string;
};

export type DayCoverage = { date: string; meta: boolean; ledger: boolean };

export type CoverageResult = {
  /** What the preset asked for. */
  requested: Range;
  /** What was actually collected — every figure is computed over this. */
  range: Range;
  clipped: boolean;
  requestedDays: number;
  clippedDays: number;
  /** Days INSIDE the clipped window with no rows for a blocking feed. */
  interiorGaps: string[];
  /** clippedDays ÷ requestedDays, 0–1. */
  ratio: number;
  /** Under 60% of what was asked: no delta can be honest, so show none. */
  suppressDeltas: boolean;
  /** The feed that bound the edge, if clipping happened. */
  boundBy: BlockingFeed | null;
  note: string | null;
};

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

function dayCount(range: Range): number {
  return Math.round((Date.parse(range.until) - Date.parse(range.since)) / DAY) + 1;
}

export function normaliseCoverage(rows: DayCoverageRow[]): DayCoverage[] {
  return rows.map((r) => ({
    date: String(r.date).slice(0, 10),
    meta: Number(r.meta_rows) > 0,
    ledger: Number(r.ledger_rows) > 0,
  }));
}

export function resolveCoveredRange(
  requested: Range,
  days: DayCoverage[],
  blocking: BlockingFeed[] = ["meta"],
): CoverageResult {
  const requestedDays = dayCount(requested);
  const inRange = days
    .filter((d) => d.date >= requested.since && d.date <= requested.until)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const covered = (d: DayCoverage) => blocking.every((f) => d[f]);

  // Walk back from the requested end until every blocking feed has rows.
  let lastIndex = inRange.length - 1;
  while (lastIndex >= 0 && !covered(inRange[lastIndex]!)) lastIndex -= 1;

  if (lastIndex < 0) {
    return {
      requested,
      range: requested,
      clipped: false,
      requestedDays,
      clippedDays: 0,
      interiorGaps: inRange.map((d) => d.date),
      ratio: 0,
      suppressDeltas: true,
      boundBy: blocking[0] ?? null,
      note: `nothing was collected in ${requested.since} → ${requested.until}`,
    };
  }

  const edge = inRange[lastIndex]!.date;
  const clipped = edge < requested.until;
  const range: Range = { since: requested.since, until: edge };
  const clippedDays = dayCount(range);
  const interiorGaps = inRange
    .slice(0, lastIndex + 1)
    .filter((d) => !covered(d))
    .map((d) => d.date);

  const boundBy = clipped
    ? (blocking.find((f) => !inRange[inRange.length - 1]?.[f]) ?? blocking[0] ?? null)
    : null;

  const ratio = requestedDays > 0 ? clippedDays / requestedDays : 0;

  return {
    requested,
    range,
    clipped,
    requestedDays,
    clippedDays,
    interiorGaps,
    ratio,
    suppressDeltas: ratio < 0.6,
    boundBy,
    note: clipped
      ? `${requestedDays - clippedDays} day${requestedDays - clippedDays === 1 ? "" : "s"} not collected`
      : interiorGaps.length > 0
        ? `${interiorGaps.length} of ${clippedDays} days in this window were not collected`
        : null,
  };
}

/** The prior window of the SAME length as the CLIPPED window. */
export function priorOfClipped(coverage: CoverageResult): Range {
  const since = Date.parse(coverage.range.since);
  const until = Date.parse(coverage.range.until);
  const days = coverage.clippedDays > 0 ? coverage.clippedDays : 1;
  void until;
  return {
    since: iso(since - days * DAY),
    until: iso(since - DAY),
  };
}

/** "23–29 Aug" — compact, no year, IST-agnostic (dates are already dates). */
export function shortRange(range: Range): string {
  const fmt = (s: string, withMonth: boolean) => {
    const d = new Date(`${s}T00:00:00Z`);
    return d.toLocaleDateString("en-IN", {
      day: "numeric",
      ...(withMonth ? { month: "short" as const } : {}),
      timeZone: "UTC",
    });
  };
  const sameMonth = range.since.slice(0, 7) === range.until.slice(0, 7);
  return `${fmt(range.since, !sameMonth)}–${fmt(range.until, true)}`;
}
