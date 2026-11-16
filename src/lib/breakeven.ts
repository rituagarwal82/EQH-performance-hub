import type { BreakEvenInputs, MeasuredAscension } from "./dashboard-types";
import { divideMetrics, modelled, toNum, unmeasured, type Metric } from "./metric";

/**
 * Maximum defensible cost per registration.
 *
 * value per buyer   = L1 price + back-end price × ascension rate
 * value per 1,000   = value per buyer × buyers per 1,000 registrations
 * ceiling           = value per 1,000 ÷ 1,000
 *
 * The two inputs that used to be guessed — back-end price and ascension rate —
 * are now READ from the collections ledger. The result is still `modelled`,
 * because a ceiling is a projection whatever its inputs are made of, and it is
 * never rendered without front-end ROAS beside it.
 */
export function breakEvenCeiling(inputs: BreakEvenInputs): number | null {
  const { l1Price, backendPrice, ascensionRate, buyersPer1000 } = inputs;
  if (![l1Price, backendPrice, ascensionRate, buyersPer1000].every(Number.isFinite)) return null;
  if (buyersPer1000 <= 0) return null;
  const valuePerBuyer = l1Price + backendPrice * (ascensionRate / 100);
  return (valuePerBuyer * buyersPer1000) / 1000;
}

export type ResolvedCeiling = {
  ceiling: Metric;
  /** Inputs actually used, each labelled measured or assumed. */
  inputs: { label: string; value: string; measured: boolean }[];
  backendPrice: number;
  ascensionRate: number;
  measuredBackend: boolean;
  measuredAscension: boolean;
};

export function resolveCeiling(
  settings: BreakEvenInputs,
  ascension: MeasuredAscension | null,
): ResolvedCeiling {
  const l3Ticket = toNum(ascension?.l3_avg_ticket ?? null);
  const ascPct = toNum(ascension?.ascension_pct ?? null);
  const l1Ticket = toNum(ascension?.l1_avg_ticket ?? null);
  // Buyers per 1,000 used to be a typed-in assumption. It is now measured:
  // paid-attributed L1 sales ÷ Meta registrations over a closed trailing
  // window, so the ceiling moves when the funnel moves.
  const measuredBuyers = toNum(ascension?.buyers_per_1000 ?? null);
  const buyersPer1000 = measuredBuyers ?? settings.buyersPer1000;

  const backendPrice = l3Ticket ?? settings.backendPrice;
  const ascensionRate = ascPct ?? settings.ascensionRate;
  // Owner ruling, 22 Sep 2026: never assume a sale price. The L1 side of the
  // ceiling is the realised average from the ledger; if no cash has been
  // recorded, the ceiling is not produced at all.
  const l1Price = l1Ticket;

  const value = l1Price === null ? null : breakEvenCeiling({
    ...settings,
    l1Price,
    backendPrice,
    ascensionRate,
    buyersPer1000,
  });

  const inputs = [
    {
      label: "L1 average realised sale, ex-GST",
      value: l1Price === null ? "not measured" : fmt(l1Price),
      measured: l1Price !== null,
    },
    { label: "L3 average ticket, ex-GST", value: fmt(backendPrice), measured: l3Ticket !== null },
    { label: "L1→L3 ascension", value: `${ascensionRate}%`, measured: ascPct !== null },
    {
      label: "buyers per 1,000 registrations",
      value: measuredBuyers === null ? String(settings.buyersPer1000) : measuredBuyers.toFixed(1),
      measured: measuredBuyers !== null,
    },
  ];

  const note = `modelled from ${inputs.map((i) => `${i.label} ${i.value}${i.measured ? " (measured from the ledger)" : " (assumed)"}`).join(", ")}`;

  return {
    ceiling:
      value === null
        ? unmeasured(
            l1Price === null
              ? "no cash recorded yet, so the average sale value is not measured — a price is never assumed"
              : "break-even inputs incomplete — set them in Settings",
          )
        : modelled(value, note),
    inputs,
    backendPrice,
    ascensionRate,
    measuredBackend: l3Ticket !== null,
    measuredAscension: ascPct !== null,
  };
}

function fmt(n: number) {
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

export function ceilingAssumptions(inputs: BreakEvenInputs): string {
  return [
    `L1 average realised sale, measured from the ledger`,
    `back-end ₹${inputs.backendPrice}`,
    `ascension ${inputs.ascensionRate}%`,
    `${inputs.buyersPer1000} buyers per 1,000 registrations`,
    inputs.buyersPer1000Note ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Paid front-end ROAS, ex-GST.
 *
 * The numerator counts only first-time L1 sales whose buyer is a lead carrying
 * a paid marker, divided by 1.18 so it sits on the same tax basis as Meta
 * spend, which is ex-GST. Money from buyers we never acquired — podcast,
 * organic, referral — and instalments on sales made in earlier months are held
 * out entirely: they are real cash, but they are not what the ads bought.
 */
export function paidFrontEndRoas(paidExGst: Metric, spend: Metric): Metric {
  return divideMetrics(
    paidExGst,
    spend,
    "paid-attributed new-sale collections ex-GST ÷ Meta spend over the same window",
  );
}

/**
 * All L1 cash ÷ spend. Kept only so the blended tile can show the ratio in a
 * de-emphasised way; it is never an ad-performance figure and is never labelled
 * front-end ROAS.
 */
export function blendedCashRatio(collected: Metric, spend: Metric): Metric {
  return divideMetrics(collected, spend, "all L1 collections ÷ Meta spend — not an ad metric");
}
