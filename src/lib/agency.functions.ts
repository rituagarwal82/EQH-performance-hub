import { createServerFn } from "@tanstack/react-start";
import { safeMessage } from "./safe-error";

/**
 * TEAM (AGENCY) ATTRIBUTION — from the utm_source suffix convention agreed
 * with the ad teams. The rules live in `utm_agency_map` and are editable in
 * Settings. Anything that does not match a suffix stays unassigned: plain
 * `FACEBOOK` and `Meta` are ambiguous historical templates and must never be
 * silently credited to a team.
 *
 * Spend is NOT splittable by team — both teams run inside the same ad
 * accounts — so this dimension carries counts only. No per-team cost per sale
 * is ever derived from whole-account spend.
 */

export type AgencyRule = {
  suffix: string;
  agency_code: string;
  label: string | null;
  note: string | null;
};

export type AgencyLeadRow = {
  agency_code: string;
  leads: number | string;
  registered_leads: number | string;
  leads_with_email: number | string;
  sales: number | string;
};

export const getAgencyMap = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ rules: AgencyRule[]; error: string | null }> => {
    const { getPg, pgSelect } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { rules: [], error: null };
    try {
      const rules = await pgSelect<AgencyRule[]>(
        pg,
        "/utm_agency_map?select=suffix,agency_code,label,note&order=suffix",
      );
      return { rules: rules ?? [], error: null };
    } catch (e) {
      return { rules: [], error: safeMessage(e) };
    }
  },
);

export const saveAgencyRule = createServerFn({ method: "POST" })
  .inputValidator((data: { suffix: string; agency_code: string; label?: string | null }) => ({
    suffix: String(data.suffix ?? "").trim(),
    agency_code: String(data.agency_code ?? "")
      .trim()
      .toUpperCase(),
    label: data.label?.trim() ? data.label.trim() : null,
  }))
  .handler(async ({ data }) => {
    const { getPg, pgUpsert } = await import("./pg.server");
    const pg = getPg();
    if (!pg) throw new Error("Database is not configured");
    if (!data.suffix.startsWith("_")) throw new Error("A suffix must start with an underscore");
    if (!data.agency_code) throw new Error("A team code is required");
    await pgUpsert(pg, "utm_agency_map", { ...data, updated_at: new Date().toISOString() });
    return { ok: true };
  });

export const deleteAgencyRule = createServerFn({ method: "POST" })
  .inputValidator((data: { suffix: string }) => ({ suffix: String(data.suffix ?? "").trim() }))
  .handler(async ({ data }) => {
    const { getPg, pgDelete } = await import("./pg.server");
    const pg = getPg();
    if (!pg) throw new Error("Database is not configured");
    await pgDelete(pg, "utm_agency_map", `suffix=eq.${encodeURIComponent(data.suffix)}`);
    return { ok: true };
  });

/** Whether a team's ad spend actually reaches us (I-SYM). */
export type AgencySpendStatus = {
  agency_code: string;
  spend_synced: boolean;
  note: string | null;
  ratios_computable: boolean;
  ratio_note: string | null;
  ad_coverage_pct: number | string | null;
  /**
   * Earliest business date from which this team's money ratios are honest —
   * the point its spend moved into ad accounts of its own. Before it, the team
   * ran inside a shared account and no per-team ratio can be separated, so a
   * range that starts earlier must still be refused. NULL = never valid.
   */
  ratios_valid_from?: string | null;
};

/**
 * Which teams may have money RATIOS computed for them at all.
 *
 * Set by rule in the database: the team's own ad spend must be syncing AND at
 * least 60% of its recent leads must trace back to ads inside its own
 * accounts. Nothing here is a default — an unknown team is refused.
 */
export const getAgencyRatioFlags = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    codes: string[];
    validFrom: Record<string, string | null>;
    rows: AgencySpendStatus[];
  }> => {
    const { getPg, pgSelect } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { codes: [], validFrom: {}, rows: [] };
    try {
      const rows = await pgSelect<AgencySpendStatus[]>(
        pg,
        "/agency_spend_status?select=agency_code,spend_synced,note,ratios_computable,ratio_note,ad_coverage_pct,ratios_valid_from",
      );
      return {
        codes: (rows ?? []).filter((r) => r.ratios_computable).map((r) => r.agency_code),
        validFrom: Object.fromEntries(
          (rows ?? []).map((r) => [r.agency_code, r.ratios_valid_from ?? null]),
        ),
        rows: rows ?? [],
      };
    } catch {
      return { codes: [], validFrom: {}, rows: [] };
    }
  },
);

/** Lead and sale COUNTS per team code. Never money per team. */
export const getAgencyLeadRollup = createServerFn({ method: "GET" })
  .inputValidator((data: { since: string; until: string }) => ({
    since: String(data.since),
    until: String(data.until),
  }))
  .handler(
    async ({
      data,
    }): Promise<{ rows: AgencyLeadRow[]; spend: AgencySpendStatus[]; error: string | null }> => {
      const { getPg, pgRpc, pgSelect } = await import("./pg.server");
      const pg = getPg();
      if (!pg) return { rows: [], spend: [], error: null };
      try {
        const [rows, spend] = await Promise.all([
          pgRpc<AgencyLeadRow[]>(pg, "lead_agency_rollup", {
            p_since: data.since,
            p_until: data.until,
          }),
          pgSelect<AgencySpendStatus[]>(
            pg,
            "/agency_spend_status?select=agency_code,spend_synced,note,ratios_computable,ratio_note,ad_coverage_pct,ratios_valid_from",
          ),
        ]);
        return { rows: rows ?? [], spend: spend ?? [], error: null };
      } catch (e) {
        return { rows: [], spend: [], error: safeMessage(e) };
      }
    },
  );
