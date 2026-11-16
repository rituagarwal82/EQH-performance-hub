/**
 * The per-ad table the daily email shows, read by the Creative screen from the
 * same stored function, so the screen and the email can never disagree.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { safeMessage } from "./safe-error";

export type AdPerfRow = {
  entity_id: string;
  ad_name: string | null;
  account_id: string | null;
  agency_code: string | null;
  thumbnail_url: string | null;
  permalink_url: string | null;
  spend: number;
  registrations: number;
  cost_per_reg: number | null;
  sales: number;
  cost_per_sale: number | null;
};

export type AdPerfData = { days: number; rows: AdPerfRow[]; error: string | null };

export const getAdPerformance = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ days: z.number().int().min(1).max(90) }).parse(data))
  .handler(async ({ data }): Promise<AdPerfData> => {
    const { fetchAdRows } = await import("./email-blocks.server");
    try {
      const rows = await fetchAdRows(data.days);
      return { days: data.days, rows, error: null };
    } catch (e) {
      return { days: data.days, rows: [], error: safeMessage(e) };
    }
  });
