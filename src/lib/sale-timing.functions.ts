import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeMessage } from "./safe-error";

/**
 * When a sale lands relative to the most recent webinar business day.
 *
 * The ledger records a DATE, not a timestamp, so a true "during the webinar"
 * bucket is not computable from this database and is not offered. Same-day is
 * as close as the data honestly gets, and every row says so.
 *
 * Monthly only. At roughly eight sales a day a weekly split swings by more than
 * ten points on noise alone, so no finer grain is exposed.
 */

export type SaleTimingRow = {
  period: string;
  bucket: "same_day" | "d1_7" | "d8_plus" | "no_session";
  sales: number | string;
  collected: number | string;
  lag_known: number | string;
};

export const BUCKET_LABEL: Record<SaleTimingRow["bucket"], string> = {
  same_day: "Same day as a session",
  d1_7: "1–7 days after",
  d8_plus: "8+ days after",
  no_session: "No session on or before",
};

export const getSaleTiming = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    z.object({ since: z.string(), until: z.string(), tier: z.string() }).parse(data),
  )
  .handler(async ({ data }): Promise<{ rows: SaleTimingRow[]; error: string | null }> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { rows: [], error: null };
    try {
      const rows = await pgRpc<SaleTimingRow[]>(pg, "ledger_sale_timing_monthly", {
        p_start: data.since,
        p_end: data.until,
        p_tier: data.tier,
      });
      return { rows: rows ?? [], error: null };
    } catch (e) {
      return { rows: [], error: safeMessage(e) };
    }
  });
