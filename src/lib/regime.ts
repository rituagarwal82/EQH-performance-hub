/**
 * Regime boundaries.
 *
 * A comparison that crosses the day a team stopped buying is not a comparison
 * of performance — half of one side was bought by people who no longer buy
 * anything. The screen must say so, exactly the way clipped coverage does.
 */

export type RegimeBoundary = {
  event_key: string;
  agency_code: string | null;
  boundary_date: string;
  label: string;
  plain: string;
};

export type RegimeCrossing = RegimeBoundary & {
  /** Which side of the shown window the boundary sits inside. */
  where: "window" | "comparison";
};

function inside(date: string, since: string, until: string): boolean {
  return date > since && date <= until;
}

/**
 * A boundary counts when it falls inside the window on screen, or when the
 * window and the period it is being compared against sit on opposite sides
 * of it.
 */
export function regimeCrossings(
  boundaries: RegimeBoundary[],
  range: { since: string; until: string },
  prior?: { since: string; until: string } | null,
): RegimeCrossing[] {
  const out: RegimeCrossing[] = [];
  for (const b of boundaries) {
    if (inside(b.boundary_date, range.since, range.until)) {
      out.push({ ...b, where: "window" });
    } else if (prior && inside(b.boundary_date, prior.since, range.until)) {
      out.push({ ...b, where: "comparison" });
    }
  }
  return out;
}
