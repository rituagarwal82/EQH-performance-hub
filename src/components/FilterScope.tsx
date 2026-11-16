import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { FilterDimension } from "@/lib/contracts";

/**
 * WHICH FILTERS ARE ACTIVE ON THIS SCREEN.
 *
 * A filter × metric combination is itself a metric. The render gate in
 * <MetricValue /> needs to know what the screen is currently sliced by, and it
 * must not have to ask each screen politely — so the active dimensions live in
 * context, set once per page, and every contracted figure underneath is
 * checked against them.
 */
export type ActiveFilters = {
  /** Team code (SD / RJ / PRM), when the team selector is on. */
  agency?: string | undefined;
  /** Ad account id, when a single account is being looked at. */
  account?: string | undefined;
  /** Placement, when a single placement is being looked at. */
  placement?: string | undefined;
  /**
   * Teams whose ratio inputs all come from their own synced universe. Set by
   * rule in the database (`refresh_agency_ratio_flags`), never by hand.
   */
  ratiosComputable?: string[] | undefined;
  /**
   * Per team, the earliest business date from which its ratios are honest —
   * the date its spend moved into ad accounts of its own. Before that the team
   * ran inside a shared account, so nothing separable exists to divide.
   */
  ratiosValidFrom?: Record<string, string | null> | undefined;
  /** First day of the range on screen (YYYY-MM-DD), checked against the above. */
  rangeStart?: string | undefined;
};

const Ctx = createContext<ActiveFilters>({});

export function FilterScope({
  agency,
  account,
  placement,
  ratiosComputable,
  ratiosValidFrom,
  rangeStart,
  children,
}: ActiveFilters & { children: ReactNode }) {
  const value = useMemo<ActiveFilters>(
    () => ({ agency, account, placement, ratiosComputable, ratiosValidFrom, rangeStart }),
    [agency, account, placement, ratiosComputable, ratiosValidFrom, rangeStart],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFilterScope(): ActiveFilters {
  return useContext(Ctx);
}

/**
 * The dimensions actually sliced right now, in refusal order.
 *
 * The team dimension is active whenever a team filter is set — ALWAYS, with no
 * exception for a team whose coverage looks good. Whether a figure can be split
 * by team is a property of that figure's own contract, never of a coverage
 * flag: a metric declaring `filters: []` divides one universe by another under
 * `?agency=` and must refuse forever. Making this conditional once produced an
 * ~8× overstated ROAS with no suspect mark; it must never be conditional again.
 */
export function activeDimensions(f: ActiveFilters): FilterDimension[] {
  const out: FilterDimension[] = [];
  if (f.agency) out.push("agency");
  if (f.account) out.push("account");
  if (f.placement) out.push("placement");
  return out;
}

/**
 * Second, independent gate. Some figures CAN be split by team structurally
 * (their contract declares `agency`) but are only honest once that team's own
 * spend is connected and enough of its leads trace to its own ads. This decides
 * that; it can never widen what `activeDimensions` refuses, only narrow it.
 */
export function agencyCoverageBlocked(f: ActiveFilters, needsCoverage: boolean): boolean {
  if (!f.agency || !needsCoverage) return false;
  return !agencyRatiosAllowed(f);
}


/**
 * True when this team's own spend/leads/ads all live in its own universe AND
 * the range on screen lies entirely inside the period where that was true.
 * Validity is never applied backwards: a range reaching into the shared-account
 * era is refused even for a team that is separable today.
 */
export function agencyRatiosAllowed(f: ActiveFilters): boolean {
  if (!f.agency) return true;
  if (!(f.ratiosComputable?.includes(f.agency) ?? false)) return false;
  const from = f.ratiosValidFrom?.[f.agency] ?? null;
  if (!from) return false;
  if (!f.rangeStart) return false;
  return f.rangeStart >= from;
}
