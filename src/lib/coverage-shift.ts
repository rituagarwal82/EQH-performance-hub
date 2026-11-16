import type { Totals } from "@/lib/account-view";

export type CoverageInfo = {
  clippedDays: number;
  requestedDays: number;
  suppressDeltas: boolean;
} | null;

/**
 * A measured-account figure compared across two periods whose measured share
 * of spend moved is not a trend — it is a change of denominator wearing a
 * trend's clothes. Ten points of movement kills the comparison outright.
 *
 * Lifted out of Today so every screen that prints a period-on-period change
 * suppresses it on exactly the same rule.
 */
export function coverageDeltaGuard(
  now: Totals,
  prior: Totals,
  coverage: CoverageInfo,
): { suppress: boolean; reason?: string } {
  const share = (x: Totals) =>
    (x.spend.value ?? 0) > 0 ? ((x.measuredSpend.value ?? 0) / (x.spend.value ?? 1)) * 100 : null;
  const nowShare = share(now);
  const priorShare = share(prior);
  const shift =
    nowShare !== null && priorShare !== null ? Math.abs(nowShare - priorShare) : null;
  const shifted = shift !== null && shift >= 10;

  if (coverage?.suppressDeltas) {
    return {
      suppress: true,
      reason: `only ${coverage.clippedDays} of the ${coverage.requestedDays} requested days were collected — under 60%, so no comparison is shown`,
    };
  }
  if (shifted) {
    return {
      suppress: true,
      reason: `measured spend covered ${Math.round(priorShare!)}% of the earlier period and ${Math.round(nowShare!)}% of this one — the two are not comparable, so no change is shown`,
    };
  }
  return { suppress: false };
}
