import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { safeMessage } from "./safe-error";

/**
 * THE AGENCY REPORT — READ ONLY.
 *
 * Everything here comes from the two stored tables built in Phase A
 * (`agency_month`, `agency_cohort`), which are themselves rebuilt from
 * `sale_attribution`. Nothing on this path recomputes a sale, a registration
 * or a rupee: if the Agencies screen disagrees with Sources or the ledger,
 * the agency tables are wrong, not the screen.
 */

export type AgencyMonthRow = {
  month: string;
  channel: string;
  agency_code: string | null;
  spend: number | string;
  retarget_spend: number | string;
  spend_known: boolean;
  spend_note: string | null;
  registrations: number | string;
  show_ups: number | string;
  sales: number | string;
  fully_paid: number | string;
  cash: number | string;
  webinar_sales: number | string;
  followup_sales: number | string;
  other_timing_sales: number | string;
  no_attendance_sales: number | string;
  buyers: number | string;
  later_cash_90: number | string;
  later_cash_per_buyer: number | string | null;
  diamond_buyers: number | string;
  window_open: boolean;
  ratios_ok: boolean;
  ratios_reason: string | null;
  cost_per_registration: number | string | null;
  cost_per_show_up: number | string | null;
  cost_per_sale: number | string | null;
  front_end_return: number | string | null;
};

export type AgencyCohortRow = {
  month: string;
  channel: string;
  registrations: number | string;
  show_ups: number | string;
  show_up_pct: number | string | null;
  buyers: number | string;
  webinar_sales: number | string;
  followup_sales: number | string;
  other_timing_sales: number | string;
  no_attendance_sales: number | string;
  later_cash_90: number | string;
  later_cash_per_buyer: number | string | null;
  diamond_buyers: number | string;
  window_open: boolean;
  too_few: boolean;
};

export type AgencyReport = {
  months: string[];
  month: string;
  activity: AgencyMonthRow[];
  cohort: AgencyCohortRow[];
  /** The ledger's own L1 sale count for the month — the reconciliation line. */
  ledgerSales: number | null;
  error: string | null;
};

const MONTH_FIELDS =
  "month,channel,agency_code,spend,retarget_spend,spend_known,spend_note,registrations,show_ups,sales,fully_paid,cash,webinar_sales,followup_sales,other_timing_sales,no_attendance_sales,buyers,later_cash_90,later_cash_per_buyer,diamond_buyers,window_open,ratios_ok,ratios_reason,cost_per_registration,cost_per_show_up,cost_per_sale,front_end_return";

const COHORT_FIELDS =
  "month,channel,registrations,show_ups,show_up_pct,buyers,webinar_sales,followup_sales,other_timing_sales,no_attendance_sales,later_cash_90,later_cash_per_buyer,diamond_buyers,window_open,too_few";

function monthBounds(month: string) {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const endDate = new Date(Date.UTC(y!, m!, 0));
  return { start, end: endDate.toISOString().slice(0, 10) };
}

export const getAgencyReport = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ month: z.string().optional() }).parse(data ?? {}))
  .handler(async ({ data }): Promise<AgencyReport> => {
    const { getPg, pgSelect } = await import("./pg.server");
    const pg = getPg();
    const empty: AgencyReport = {
      months: [],
      month: data.month ?? "",
      activity: [],
      cohort: [],
      ledgerSales: null,
      error: null,
    };
    if (!pg) return empty;
    try {
      const monthRows = await pgSelect<{ month: string }[]>(
        pg,
        "/agency_month?select=month&order=month.desc",
      );
      const months = [...new Set((monthRows ?? []).map((r) => r.month))].sort().reverse();
      if (months.length === 0) return empty;

      // Default: the last month that has actually finished, so a half-written
      // month is never the first thing the owner reads.
      const today = new Date();
      const thisMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
      const fallback = months.find((m) => m < thisMonth) ?? months[0]!;
      const month = data.month && months.includes(data.month) ? data.month : fallback;
      const { start, end } = monthBounds(month);

      const [activity, cohort, ledger] = await Promise.all([
        pgSelect<AgencyMonthRow[]>(
          pg,
          `/agency_month?select=${MONTH_FIELDS}&month=eq.${month}&order=sales.desc`,
        ),
        pgSelect<AgencyCohortRow[]>(
          pg,
          `/agency_cohort?select=${COHORT_FIELDS}&month=eq.${month}&order=registrations.desc`,
        ),
        pgSelect<{ row_hash: string }[]>(
          pg,
          `/ledger_inflow?select=row_hash&product_tier=eq.L1_SILVER&is_new_sale=is.true&business_date=gte.${start}&business_date=lte.${end}`,
        ),
      ]);

      return {
        months,
        month,
        activity: activity ?? [],
        cohort: cohort ?? [],
        ledgerSales: (ledger ?? []).length,
        error: null,
      };
    } catch (e) {
      return { ...empty, error: safeMessage(e) };
    }
  });
