import type {
  AccountRole,
  AccountRollupRow,
  EntityRollupRow,
  LeadTrackingStatus,
} from "./dashboard-types";
import {
  degrade,
  divideMetrics,
  fromNullable,
  fromObserved,
  type Metric,
  sumMetrics,
  toNum,
  unmeasured,
} from "./metric";

export const TRACKING_LABEL: Record<LeadTrackingStatus, string> = {
  working: "Lead tracking working",
  broken:
    "This account's ads deliver, but its lead event reports nothing to Meta, so cost-per-lead cannot be computed. Fix is in the account's pixel/event setup — flagged to Sabhi Digital.",
  unknown: "Lead tracking unverified",
  not_applicable: "No lead objective",
};


export type AccountView = {
  row: AccountRollupRow;
  spend: Metric;
  leads: Metric;
  impressions: Metric;
  landingPageViews: Metric;
  purchases: Metric;
  linkClicks: Metric;
  cpl: Metric;
  /** true when the account observed a real zero rather than reporting nothing. */
  observedZeroSpend: boolean;
  tracking: LeadTrackingStatus;
  role: AccountRole;
};

export const RETARGETING_CAPTION =
  "retargeting / brand — not expected to create new leads";

export function roleOf(row: { account_role?: AccountRole | null }): AccountRole {
  return row.account_role === "retargeting_brand" ? "retargeting_brand" : "lead_gen";
}

function leadsNote(row: {
  lead_tracking_status: LeadTrackingStatus;
  days_missing_leads: number | string;
  account_role?: AccountRole | null;
}) {
  // A retargeting account showing no registrations is the plan, not a fault.
  if (roleOf(row) === "retargeting_brand") return RETARGETING_CAPTION;
  if (row.lead_tracking_status === "broken")
    return "this account has no lead tracking — its ads deliver, but the lead event reports nothing to Meta, so cost-per-lead cannot be computed";

  if (row.lead_tracking_status === "unknown")
    return "lead tracking on this account has never been verified";
  const missing = toNum(row.days_missing_leads) ?? 0;
  return missing > 0 ? `${missing} day(s) in this range reported no registration data` : undefined;
}

export type ViewOptions = {
  /** Days in the window being reported. Any account with fewer collected days
   * than this yields totals that are floors, not facts. */
  rangeDays?: number | undefined;
};

/** Interior-gap rule: fewer collected days than the window has → partial. */
function applyDayGap(m: Metric, days: number | null, rangeDays: number | undefined): Metric {
  if (!rangeDays || days === null || days >= rangeDays) return m;
  const missing = rangeDays - days;
  return degrade(
    m,
    "partial",
    `${missing} of ${rangeDays} days in this window were not collected — this total is a floor`,
  );
}

export function accountView(row: AccountRollupRow, opts: ViewOptions = {}): AccountView {
  const days = toNum(row.days_with_data);
  const hasRows = (days ?? 0) > 0;
  const spend = hasRows ? fromObserved(row.spend) : unmeasured("this account reported no rows for this range");
  const note = leadsNote(row);
  const rawLeads = fromNullable(row.leads, note);
  // A broken tracker's number is not a measurement, whatever it prints.
  const leads =
    row.lead_tracking_status === "broken"
      ? unmeasured(note)
      : note && rawLeads.value !== null
        ? { ...rawLeads, state: "partial" as const, note }
        : rawLeads;

  const gap = (m: Metric) => applyDayGap(m, days, opts.rangeDays);

  const view: AccountView = {
    row,
    spend: gap(spend),
    leads: gap(leads),
    impressions: gap(hasRows ? fromNullable(row.impressions) : unmeasured()),
    landingPageViews: gap(
      fromNullable(row.landing_page_views, "Meta reported no landing-page-view action for this range"),
    ),
    purchases: gap(
      fromNullable(row.purchases, "Meta reported no purchase action for this range"),
    ),
    linkClicks: gap(hasRows ? fromNullable(row.link_clicks) : unmeasured()),
    cpl: unmeasured(),
    observedZeroSpend: hasRows && (toNum(row.spend) ?? 0) === 0,
    tracking: row.lead_tracking_status,
    role: roleOf(row),
  };
  view.cpl = divideMetrics(view.spend, view.leads, note);
  return view;
}

export type EntityView = Omit<AccountView, "row" | "observedZeroSpend"> & {
  row: EntityRollupRow;
};

export function entityView(row: EntityRollupRow): EntityView {
  const note = leadsNote(row);
  const rawLeads = fromNullable(row.leads, note);
  const leads = row.lead_tracking_status === "broken" ? unmeasured(note) : rawLeads;
  const spend = fromObserved(row.spend);
  return {
    row,
    role: "lead_gen",
    spend,
    leads,
    impressions: fromNullable(row.impressions),
    landingPageViews: fromNullable(row.landing_page_views),
    purchases: fromNullable(row.purchases),
    linkClicks: fromNullable(row.link_clicks),
    cpl: divideMetrics(spend, leads, note),
    tracking: row.lead_tracking_status,
  };
}

export type Totals = {
  spend: Metric;
  leads: Metric;
  impressions: Metric;
  landingPageViews: Metric;
  purchases: Metric;
  linkClicks: Metric;
  /** Spend on accounts whose lead tracking is known to work. */
  measuredSpend: Metric;
  /** Registrations on those accounts only — the only defensible denominator. */
  measuredLeads: Metric;
  costPerMeasuredRegistration: Metric;
  unmeasuredSpend: Metric;
  measuredShare: number | null;
};

/** Every total on every screen comes from here, so the weakest-input rule cannot be skipped. */
export function totals(views: AccountView[]): Totals {
  const spend = sumMetrics(views.map((v) => v.spend));
  const measuredViews = views.filter((v) => v.tracking === "working");
  const measuredSpend = sumMetrics(measuredViews.map((v) => v.spend));
  const measuredLeads = sumMetrics(measuredViews.map((v) => v.leads));
  // A retargeting / brand account is not expected to create registrations, so
  // its spend is not "spend with no working lead tracking" — calling it that
  // made a deliberate choice look like a fault.
  const unmeasuredSpend = sumMetrics(
    views
      .filter((v) => v.tracking !== "working" && v.role !== "retargeting_brand")
      .map((v) => v.spend),
  );

  return {
    spend,
    leads: sumMetrics(views.map((v) => v.leads)),
    impressions: sumMetrics(views.map((v) => v.impressions)),
    landingPageViews: sumMetrics(views.map((v) => v.landingPageViews)),
    purchases: sumMetrics(views.map((v) => v.purchases)),
    linkClicks: sumMetrics(views.map((v) => v.linkClicks)),
    measuredSpend,
    measuredLeads,
    costPerMeasuredRegistration: divideMetrics(
      measuredSpend,
      measuredLeads,
      "computed only over accounts with working lead tracking",
    ),
    unmeasuredSpend,
    measuredShare:
      spend.value && spend.value > 0 && measuredSpend.value !== null
        ? (measuredSpend.value / spend.value) * 100
        : null,
  };
}

/** Rows that cannot be ranked sort into a terminal group, never as if zero. */
export function splitRankable<T>(rows: T[], metricOf: (row: T) => Metric) {
  const rankable: T[] = [];
  const unrankable: T[] = [];
  for (const r of rows) {
    const m = metricOf(r);
    if (m.value === null || m.state === "unmeasured") unrankable.push(r);
    else rankable.push(r);
  }
  return { rankable, unrankable };
}
