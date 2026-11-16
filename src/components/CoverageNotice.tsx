import type { CoverageResult } from "@/lib/coverage";
import { shortRange } from "@/lib/coverage";
import { RANGE_LABELS, type RangePreset } from "@/lib/date-range";

/**
 * The window that was asked for, struck through, next to the window that
 * actually exists. A screen that silently substitutes one for the other is how
 * an outage gets printed as a business collapse.
 */
export function CoverageNotice({
  preset,
  coverage,
}: {
  preset: RangePreset;
  coverage: CoverageResult | null;
}) {
  if (!coverage) return null;
  const label = RANGE_LABELS[preset];

  if (!coverage.clipped && coverage.interiorGaps.length === 0) {
    return (
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {label} · {shortRange(coverage.range)}
      </span>
    );
  }

  const missing = coverage.requestedDays - coverage.clippedDays;

  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      {coverage.clipped ? (
        <>
          <s className="text-muted-foreground/70">{shortRange(coverage.requested)}</s>
          <span className="text-muted-foreground">→ showing</span>
          <span className="text-warning font-semibold">{shortRange(coverage.range)}</span>
          <span className="text-warning">
            · {missing} day{missing === 1 ? "" : "s"} not collected
          </span>
        </>
      ) : (
        <>
          <span className="font-semibold">{shortRange(coverage.range)}</span>
          <span className="text-warning">
            · {coverage.interiorGaps.length} of {coverage.clippedDays} days not collected
          </span>
        </>
      )}
      {coverage.suppressDeltas ? (
        <span
          className="bg-warning/15 text-warning rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider"
          title="Under 60% of the requested window was collected — no comparison against the prior period can be honest, so none is shown."
        >
          deltas suppressed
        </span>
      ) : null}
    </span>
  );
}
