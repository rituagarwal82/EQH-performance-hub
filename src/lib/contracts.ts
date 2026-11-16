/**
 * The client mirror of the metric definition registry (`metric_contracts`).
 *
 * A contract is the recorded meaning of a number: what it counts, on what tax
 * basis, and which calculation produces it. The database holds the authority —
 * a nightly check fingerprints each calculation and raises a review item when
 * the code moves while the recorded version stands still. This file exists so
 * a screen can refuse to render a money or ratio figure that claims a
 * definition nobody wrote down.
 *
 * Adding a metric here without adding it to `metric_contracts` is a mistake in
 * the same direction as the one this whole harness exists to prevent, so the
 * ids below are exactly the ones the database carries.
 */

export type ContractBasis = "ex_gst" | "gross" | "none";

/**
 * A filter is part of a metric's meaning, not a view setting laid on top of it.
 * "Cost per sale" and "cost per sale for team SD" are two different numbers,
 * and the second one only exists if the spend and the revenue in it come from
 * the same universe. While teams share ad accounts they do not, so every money
 * ratio declares `filters: []` and the render gate refuses it under a team
 * filter rather than dividing one team's leads by another team's spend.
 */
export type FilterDimension = "agency" | "account" | "placement";

export const FILTER_LABEL: Record<FilterDimension, string> = {
  agency: "team",
  account: "ad account",
  placement: "placement",
};

export const FILTER_REASON: Record<FilterDimension, string> = {
  agency: "not measurable per team — teams share ad accounts",
  account: "not measurable per ad account",
  placement: "not measurable per placement",
};

export type MetricContract = {
  id: string;
  label: string;
  basis: ContractBasis;
  /** One sentence: what this number counts. Shown on hover. */
  means: string;
  /** The filters this figure may be split by. Anything else is refused. */
  filters: FilterDimension[];
  /**
   * True when a team split of this figure is only honest once that team's own
   * spend is synced and enough of its leads trace to its own ads. Structural
   * support (`filters`) and coverage are separate gates; both must pass.
   */
  agencyNeedsCoverage?: boolean;
};

export const METRIC_CONTRACTS: MetricContract[] = [
  {
    id: "meta_spend",
    label: "Meta spend",
    basis: "ex_gst",
    means: "Amount spent reported by the Meta Ads API across every active ad account, ex-GST.",
    filters: ["agency", "account", "placement"],
  },
  {
    id: "registrations",
    label: "Registrations",
    basis: "none",
    means: "Leads recorded by Meta on accounts whose lead tracking is working.",
    filters: ["agency", "account"],
  },
  {
    id: "cost_per_registration",
    label: "Cost per registration",
    basis: "ex_gst",
    // Both sides of this ratio are read off the same ad accounts — Meta's own
    // spend and Meta's own lead count — so splitting it by the accounts a team
    // holds keeps numerator and denominator in one universe. That is what makes
    // it splittable where the cash ratios are not: those divide ledger money
    // coded by LEAD against spend coded by ACCOUNT, two different universes.
    means:
      "Meta spend ÷ Meta registrations over the same window, both read from the same ad accounts.",
    filters: ["agency", "account"],
    agencyNeedsCoverage: true,
  },

  {
    id: "show_up_rate",
    label: "Show-up rate",
    basis: "none",
    means: "Attendees ÷ registrants, counted only on sessions that reported both.",
    filters: [],
  },
  {
    id: "retention_60",
    label: "60-minute retention",
    basis: "none",
    means: "Attendees still present at minute 60 ÷ attendees.",
    filters: [],
  },
  {
    id: "sales_per_1000_leads",
    label: "Sales per 1,000 registrations",
    basis: "none",
    means: "Paid-attributed L1 new sales from the accounts ledger ÷ measured Meta registrations × 1,000.",
    filters: [],
  },
  {
    id: "cost_per_sale",
    label: "Cost per sale",
    basis: "ex_gst",
    means: "Measured Meta spend ÷ paid-attributed L1 new sales from the accounts ledger (seat rule applied).",
    filters: [],
  },
  {
    id: "front_end_roas",
    label: "Paid front-end ROAS",
    basis: "ex_gst",
    means: "Paid-attributed L1 new-sale cash ÷ 1.18, over Meta spend for the same window.",
    filters: [],
  },
  {
    id: "paid_collected_exgst",
    label: "Paid new-sale cash, ex-GST",
    basis: "ex_gst",
    means: "L1 new-sale collections from buyers whose lead carries a paid marker, ÷ 1.18.",
    filters: [],
  },
  {
    id: "collected",
    label: "L1 cash collected",
    basis: "gross",
    means: "All money received against L1 rows in the accounts ledger, gross of GST.",
    filters: [],
  },
  {
    id: "paid_l1_collected_gross",
    label: "Paid L1 cash, gross",
    basis: "gross",
    means: "L1 new-sale collections from paid-attributed buyers, before the GST division.",
    filters: [],
  },
  {
    id: "l1_collected_all_sources",
    label: "Blended L1 cash",
    basis: "gross",
    means: "Every rupee received on L1 rows, whatever brought the buyer in, including instalments.",
    filters: [],
  },
  {
    id: "all_tier_collected",
    label: "All-tier cash",
    basis: "gross",
    means: "Money received across every product tier in the accounts ledger.",
    filters: [],
  },
  {
    id: "ledger_l1_new_sales",
    label: "L1 new sales",
    basis: "none",
    means: "Ledger rows tagged as a new sale on the L1 tier, counted on the business day.",
    filters: ["agency"],
    agencyNeedsCoverage: true,
  },
];

const BY_ID = new Map(METRIC_CONTRACTS.map((c) => [c.id, c]));

export function contractFor(id: string | undefined | null): MetricContract | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

const BASIS_LABEL: Record<ContractBasis, string> = {
  ex_gst: "ex-GST",
  gross: "gross of GST",
  none: "a count, no tax basis",
};

export function supportsFilter(c: MetricContract, dim: FilterDimension): boolean {
  return c.filters.includes(dim);
}

export function needsAgencyCoverage(c: MetricContract): boolean {
  return c.agencyNeedsCoverage === true;
}

export function contractTitle(c: MetricContract): string {
  return `${c.label} — ${c.means} Basis: ${BASIS_LABEL[c.basis]}.`;
}
