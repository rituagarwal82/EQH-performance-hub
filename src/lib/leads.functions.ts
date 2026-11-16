import { createServerFn } from "@tanstack/react-start";
import { safeMessage } from "./safe-error";

export type LeadTrackingCoverage = {
  leads_total: number | string;
  registered: number | string;
  with_email: number | string;
  without_email: number | string;
  with_ad_id: number | string;
  ad_id_pct: number | string | null;
  /** id + name matches — the number the creative layer can actually use. */
  with_ad_ref: number | string;
  ad_ref_pct: number | string | null;
  name_exact: number | string;
  name_fuzzy: number | string;
  with_campaign: number | string;
  campaign_pct: number | string | null;
  first_capture: string | null;
  last_capture: string | null;
};

/**
 * How much of the recent lead feed carries the identifiers attribution needs.
 * Shown so the owner can watch ad-id capture rise as the URL parameters get
 * fixed — it is a measurement fact, never an input to any business figure.
 */
export const getLeadTrackingCoverage = createServerFn({ method: "GET" })
  .inputValidator((data: { days?: number } | undefined) => ({ days: data?.days ?? 30 }))
  .handler(
    async ({ data }): Promise<{ coverage: LeadTrackingCoverage | null; error: string | null }> => {
      const { getPg, pgRpc } = await import("./pg.server");
      const pg = getPg();
      if (!pg) return { coverage: null, error: null };
      try {
        const rows = await pgRpc<LeadTrackingCoverage[]>(pg, "lead_tracking_coverage", {
          p_days: data.days,
        });
        return { coverage: rows?.[0] ?? null, error: null };
      } catch (e) {
        return { coverage: null, error: safeMessage(e) };
      }
    },
  );

export type TemplateTrendRow = {
  day: string;
  old_leads: number | string;
  old_with_ad_id: number | string;
  old_with_ref: number | string;
  new_leads: number | string;
  new_with_ad_id: number | string;
  new_with_ref: number | string;
};

export type NameMatchOrphans = {
  orphan_leads: number | string;
  orphan_names: number | string;
  sample: string[] | null;
};

/**
 * Leads whose utm_content (the ad-name text the old URL template carried)
 * matches no CURRENT ad name. Name matching breaks when an ad is renamed, so
 * this count is the honesty check on the effective-attribution figure.
 */
export const getNameMatchOrphans = createServerFn({ method: "GET" })
  .inputValidator((data: { days?: number } | undefined) => ({ days: data?.days ?? 30 }))
  .handler(async ({ data }): Promise<{ orphans: NameMatchOrphans | null; error: string | null }> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { orphans: null, error: null };
    try {
      const rows = await pgRpc<NameMatchOrphans[]>(pg, "lead_name_match_orphans", {
        p_days: data.days,
      });
      return { orphans: rows?.[0] ?? null, error: null };
    } catch (e) {
      return { orphans: null, error: safeMessage(e) };
    }
  });

/**
 * Day-by-day progress of the URL-template retrofit: registered leads from
 * old-template ads (utm_source=Meta) versus new-template ads (FACEBOOK*),
 * and how many of each carry an ad id. Pure measurement, never an input.
 */
export const getLeadTemplateTrend = createServerFn({ method: "GET" })
  .inputValidator((data: { days?: number } | undefined) => ({ days: data?.days ?? 14 }))
  .handler(async ({ data }): Promise<{ rows: TemplateTrendRow[]; error: string | null }> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { rows: [], error: null };
    try {
      const rows = await pgRpc<TemplateTrendRow[]>(pg, "lead_template_trend", {
        p_days: data.days,
      });
      return { rows: rows ?? [], error: null };
    } catch (e) {
      return { rows: [], error: safeMessage(e) };
    }
  });
