import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { safeMessage } from "./safe-error";

/**
 * BACK-END RETURN BY ACQUISITION COHORT.
 *
 * A cohort is the calendar month of a buyer's FIRST L1 purchase, identified by
 * the same email/phone identity join every other money screen uses — never by
 * platform attribution. For each cohort we follow ALL later cash from those
 * same people across every tier, so the owner can see what a rupee of ad spend
 * returns over time rather than only what it returns on the front end.
 *
 * Gross throughout, by owner ruling: no fees, commission, delivery cost or
 * refunds at this reporting level.
 */

/** Below this share of matched buyers, no ratio is shown at all. */
export const COHORT_COVERAGE_GATE = 60;

/** Cohorts younger than this many whole months are still filling up. */
export const COHORT_MATURITY_MONTHS = 12;

export type CohortRow = {
  cohort_month: string;
  buyers: number | string;
  matched_buyers: number | string;
  paid_buyers: number | string;
  coverage_pct: number | string | null;
  spend: number | string | null;
  /**
   * measured  — the whole month's ad spend is connected and campaign-level
   * sx_regime — spend total is known but the closed SX era has no campaign detail
   * none      — no ad spend on record for that month; every ratio is refused
   */
  spend_basis: "measured" | "sx_regime" | "none";
  front_d30: number | string;
  back_d30: number | string;
  front_d60: number | string;
  back_d60: number | string;
  front_d90: number | string;
  back_d90: number | string;
  front_d180: number | string;
  back_d180: number | string;
  front_d365: number | string;
  back_d365: number | string;
  front_life: number | string;
  back_life: number | string;
  total_life: number | string;
  per_buyer_life: number | string | null;
  roas_d30: number | string | null;
  roas_d90: number | string | null;
  roas_d180: number | string | null;
  roas_d365: number | string | null;
  roas_life: number | string | null;
  breakeven_month: number | string | null;
  months_elapsed: number | string;
  maturing: boolean;
  /**
   * The same money counted for EVERY buyer of the month, not only those whose
   * lead traces to a Meta ad. Kept in separate fields so a buyer count is never
   * read against cash from a subset of those buyers.
   */
  front_d90_all: number | string | null;
  back_d90_all: number | string | null;
  front_life_all: number | string;
  back_life_all: number | string;
  per_buyer_life_all: number | string | null;
  per_buyer_life_paid: number | string | null;
  roas_d90_all: number | string | null;
  roas_life_all: number | string | null;
};

export const getCohortReturn = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    z.object({ from: z.string().optional() }).parse(data ?? {}),
  )
  .handler(async ({ data }): Promise<{ rows: CohortRow[]; error: string | null }> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { rows: [], error: null };
    try {
      const rows = await pgRpc<CohortRow[]>(pg, "cohort_backend_return", {
        p_from: data.from ?? "2026-01-01",
        p_to: null,
      });
      return { rows: rows ?? [], error: null };
    } catch (e) {
      return { rows: [], error: safeMessage(e) };
    }
  });

export type TierCashRow = {
  product_tier: string;
  buyers: number | string;
  sales: number | string;
  collected: number | string;
  avg_ticket: number | string | null;
};

/**
 * All cash in a window across EVERY tier, not just the front end. Read beside
 * front-end return so 0.44 is never mistaken for the whole business: it
 * includes buyers acquired in earlier months, so it is a business return, not
 * an ad-performance figure, and every screen that shows it says so.
 */
export const getAllTierCash = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    z.object({ since: z.string(), until: z.string() }).parse(data),
  )
  .handler(async ({ data }): Promise<{ rows: TierCashRow[]; error: string | null }> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { rows: [], error: null };
    try {
      const rows = await pgRpc<TierCashRow[]>(pg, "ledger_tier_summary", {
        p_start: data.since,
        p_end: data.until,
      });
      return { rows: rows ?? [], error: null };
    } catch (e) {
      return { rows: [], error: safeMessage(e) };
    }
  });
