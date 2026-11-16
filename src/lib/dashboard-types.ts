export type LeadTrackingStatus = "working" | "broken" | "unknown" | "not_applicable";

/**
 * Rows straight from the database. Nullable columns are nullable HERE too —
 * the moment a null is coerced to 0 the screen starts lying.
 */
export type AccountRollupRow = {
  account_id: string;
  name: string;
  agency_code: string | null;
  is_active: boolean;
  lead_tracking_status: LeadTrackingStatus;
  /** What the account is for. Retargeting/brand accounts are not expected to create new leads. */
  account_role?: AccountRole | null;
  spend: number | string;
  leads: number | string | null;
  impressions: number | string | null;
  landing_page_views: number | string | null;
  purchases: number | string | null;
  link_clicks: number | string | null;
  days_with_data: number | string;
  days_missing_leads: number | string;
  has_data: boolean;
};

export type AccountRole = "lead_gen" | "retargeting_brand";

export type EntityRollupRow = {
  entity_id: string;
  entity_name: string | null;
  account_id: string;
  account_name: string | null;
  lead_tracking_status: LeadTrackingStatus;
  status: string | null;
  spend: number | string;
  leads: number | string | null;
  impressions: number | string | null;
  landing_page_views: number | string | null;
  purchases: number | string | null;
  link_clicks: number | string | null;
  days_with_data: number | string;
  days_missing_leads: number | string;
};

export type DailySpendRow = {
  date: string;
  spend: number | string;
  leads: number | string | null;
  measured_spend: number | string | null;
  /** Registrations on accounts with working lead tracking — the only defensible count. */
  measured_leads: number | string | null;
};

export type MonthSpendRow = {
  month: number;
  spend: number | string;
  leads: number | string | null;
};

export type SyncRunRow = {
  started_at: string;
  finished_at: string | null;
  status: string | null;
  rows_written: number | null;
  error: string | null;
  source: string | null;
};

export type BreakEvenInputs = {
  l1Price: number;
  backendPrice: number;
  ascensionRate: number;
  buyersPer1000: number;
  buyersPer1000Note: string | null;
};

export type MeasuredAscension = {
  l1_buyers: number | string | null;
  ascended_buyers: number | string | null;
  ascension_pct: number | string | null;
  l3_avg_ticket: number | string | null;
  /** Both tickets are ex-GST (ledger cash ÷ 1.18), matching the spend basis. */
  l1_avg_ticket: number | string | null;
  cohort_start: string | null;
  cohort_end: string | null;
  /** Paid L1 buyers per 1,000 Meta registrations, measured over a closed window. */
  buyers_per_1000: number | string | null;
  buyers_window_start: string | null;
  buyers_window_end: string | null;
};

export type OverviewData = {
  configured: boolean;
  /** What the preset asked for. */
  requested: { since: string; until: string };
  /** What was actually collected — every figure below is computed over this. */
  range: { since: string; until: string };
  prior: { since: string; until: string };
  coverage: import("./coverage").CoverageResult | null;
  /** Days a team stopped buying, inside this window or the one it is compared to. */
  regimes: import("./regime").RegimeBoundary[];

  feeds: import("./feed-health.functions").FeedHealthRow[];
  accounts: AccountRollupRow[];
  priorAccounts: AccountRollupRow[];
  series: DailySpendRow[];
  lastRun: SyncRunRow | null;
  breakEven: BreakEvenInputs;
  ascension: MeasuredAscension | null;
  /** L1 collections over the clipped window, from the accounts ledger. */
  frontEnd: { sales: number; collected: number; days: number } | null;
  /**
   * The same window split into what ad spend can claim and what it cannot:
   * money from buyers with no lead record, and instalments on earlier sales,
   * are held out of the paid figure, which is then taken ex-GST to sit on the
   * same basis as Meta spend.
   */
  paidFrontEnd: {
    all: number;
    noLead: number;
    instalment: number;
    paidGross: number;
    paidExGst: number;
    /** I-SYM: cash from teams whose ad spend is not connected — excluded. */
    unsyncedGross: number;
    unsyncedRows: number;
  } | null;

  /**
   * Whole-read failure: the coverage resolution itself did not answer, so no
   * section below can be trusted.
   */
  error: string | null;
  /**
   * P0-A: one slow query must not empty the whole screen. Each section carries
   * its OWN failure, so a section either renders its data or says it could not
   * load — and never asserts a zero on behalf of a query that failed.
   */
  sections: OverviewSections;
};

export type OverviewSectionKey =
  | "accounts"
  | "priorAccounts"
  | "series"
  | "lastRun"
  | "settings"
  | "feeds"
  | "ascension"
  | "ledger"
  | "paidLedger";

export type OverviewSections = Record<OverviewSectionKey, string | null>;

export const NO_SECTION_ERRORS: OverviewSections = {
  accounts: null,
  priorAccounts: null,
  series: null,
  lastRun: null,
  settings: null,
  feeds: null,
  ascension: null,
  ledger: null,
  paidLedger: null,
};

/** Every section failed because the read never got that far. */
export function allSectionsFailed(reason: string): OverviewSections {
  return {
    accounts: reason,
    priorAccounts: reason,
    series: reason,
    lastRun: reason,
    settings: reason,
    feeds: reason,
    ascension: reason,
    ledger: reason,
    paidLedger: reason,
  };
}


export type SyncSummary = {
  status: "success" | "partial" | "error";
  rowsWritten: number;
  accountsSynced: number;
  since: string;
  until: string;
  error: string | null;
};

export type PaidDailyRow = {
  business_date: string;
  collected_all: number | string;
  collected_new_sale: number | string;
  collected_no_lead: number | string;
  collected_instalment: number | string;
  collected_paid_gross: number | string;
  collected_paid_exgst: number | string;
  rows_all: number | string;
  rows_paid: number | string;
  /** I-SYM: cash held out because that team's ad spend is not connected. */
  collected_unsynced_gross: number | string;
  rows_unsynced: number | string;
};

