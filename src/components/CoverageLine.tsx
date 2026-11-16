import { MetricValue } from "@/components/MetricValue";
import type { Totals } from "@/lib/account-view";
import { shareOf } from "@/lib/metric";

/**
 * The denominator is always RUPEES OF SPEND, never account count.
 * Four dead accounts spending ₹200 is a different problem from one spending ₹58,000.
 */
export function CoverageLine({ totals }: { totals: Totals }) {
  const measured = totals.measuredSpend;
  const total = totals.spend;
  const pct = shareOf(measured, total);
  const unknown = pct.value === null;
  const pctForWidth = unknown ? 0 : Math.max(0, Math.min(100, pct.value as number));

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-baseline gap-2 text-[12px]">
        <span className="text-muted-foreground">Measured:</span>
        <span className="nums font-semibold">
          <MetricValue metric={measured} format="inr" /> of{" "}
          <MetricValue metric={total} format="inr" />
        </span>
        <span className="nums text-muted-foreground">
          (<MetricValue metric={pct} format="percent" />)
        </span>
        <span className="text-[11px] text-muted-foreground">
          — spend on accounts with working lead tracking, as a share of all Meta spend in this
          range.
        </span>
      </div>
      {/* An unknown share must not draw as an empty bar — an empty bar reads as
          "none of your spend is measured", which is a different fact. */}
      {unknown ? (
        <p className="mt-1.5 text-[11px] italic text-muted-foreground">
          The measured share could not be worked out for this range, so no bar is drawn.
        </p>
      ) : (
        <div
          className="bg-muted mt-1.5 flex h-[3px] w-full overflow-hidden rounded-full"
          role="img"
          aria-label={`Measured spend ${Math.round(pct.value!)}% of total`}
        >
          <div className="bg-primary h-full" style={{ width: `${pctForWidth}%` }} />
          <div
            className="h-full flex-1"
            style={{
              backgroundImage:
                "repeating-linear-gradient(45deg, var(--muted-foreground) 0 2px, transparent 2px 5px)",
              opacity: 0.55,
            }}
          />
        </div>
      )}
    </div>
  );
}
