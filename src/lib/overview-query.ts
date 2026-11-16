import { queryOptions } from "@tanstack/react-query";

import { getOverview } from "./dashboard.functions";
import { priorRange, resolveRange } from "./date-range";
import type { RangeSearch } from "@/components/RangeBar";

/**
 * The REQUESTED range. What is actually shown is clipped to collected coverage
 * on the server — read `overview.range` and `overview.coverage`, never this,
 * for anything that renders a number.
 */
export function rangesFor(search: RangeSearch) {
  const range = resolveRange(search.range, { since: search.since, until: search.until });
  return { range, prior: priorRange(range) };
}

export function overviewQuery(search: RangeSearch) {
  const { range } = rangesFor(search);
  return queryOptions({
    queryKey: ["overview", range.since, range.until],
    queryFn: () => getOverview({ data: { since: range.since, until: range.until } }),
  });
}
