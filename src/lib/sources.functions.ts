import { createServerFn } from "@tanstack/react-start";
import { safeMessage } from "./safe-error";

export type SourceRow = {
  month: string;
  channel: string;
  source: string;
  /** The tool the campaign rode on (Discover, 7 Chakras) when a campaign named the channel. */
  tool: string | null;
  confidence: "confirmed" | "inferred" | "unknown" | string;
  leads: number | string;
  sales_team: number | string;
  sales_paid: number | string;
  cash: number | string;
};

export type SourceMatrix = {
  rows: SourceRow[];
  error: string | null;
};

/**
 * Months x channels, built on the unified source (one source per person, taken
 * from their very first record and never overwritten by a later re-registration).
 * Cash and sale counts come from the accounts ledger; leads from the lead system.
 */
export const getSourceMatrix = createServerFn({ method: "GET" })
  .inputValidator((data: { since?: string; until?: string } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<SourceMatrix> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { rows: [], error: null };
    try {
      const rows = await pgRpc<SourceRow[]>(pg, "source_month_matrix", {
        p_start: data.since ?? null,
        p_end: data.until ?? null,
      });
      return { rows: rows ?? [], error: null };
    } catch (e) {
      return { rows: [], error: safeMessage(e) };
    }
  });

export type DisagreementRow = {
  sale_id: string;
  business_date: string;
  email: string | null;
  tracking_answer: string;
  team_answer: string;
  evidence: string | null;
  cash: number | string;
};

/**
 * Sales where the accounts team's own source entry contradicts what tracking
 * recorded. Tracking wins; these are listed so a person can settle them.
 */
export const getSourceDisagreements = createServerFn({ method: "GET" })
  .inputValidator((data: { since?: string; until?: string } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<{ rows: DisagreementRow[]; error: string | null }> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { rows: [], error: null };
    try {
      const rows = await pgRpc<DisagreementRow[]>(pg, "sale_source_disagreements", {
        p_start: data.since ?? null,
        p_end: data.until ?? null,
      });
      return { rows: rows ?? [], error: null };
    } catch (e) {
      return { rows: [], error: safeMessage(e) };
    }
  });
