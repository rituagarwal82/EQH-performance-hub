import { createServerFn } from "@tanstack/react-start";
import { safeMessage } from "./safe-error";

export type LandingPageRow = {
  page_key: string;
  key_kind: "landing_page" | "utm_campaign" | "none" | string;
  leads: number | string;
  registered: number | string;
  first_date: string | null;
  last_date: string | null;
};

export type LandingPageData = {
  rows: LandingPageRow[];
  /** Whether any lead record carries a real landing page value. */
  hasLandingPage: boolean;
  error: string | null;
};

/**
 * Registrations grouped by the landing page recorded on the lead record, or by
 * campaign where the lead source records no page. There is still no page-view
 * source, so this is a count and never a rate.
 */
export const getLandingPageRollup = createServerFn({ method: "GET" })
  .inputValidator((data: { since?: string; until?: string } | undefined) => data ?? {})
  .handler(async ({ data }): Promise<LandingPageData> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { rows: [], hasLandingPage: false, error: null };
    try {
      const rows = await pgRpc<LandingPageRow[]>(pg, "lead_page_rollup", {
        p_start: data.since ?? null,
        p_end: data.until ?? null,
      });
      return {
        rows: rows ?? [],
        hasLandingPage: (rows ?? []).some((r) => r.key_kind === "landing_page"),
        error: null,
      };
    } catch (e) {
      return { rows: [], hasLandingPage: false, error: safeMessage(e) };
    }
  });
