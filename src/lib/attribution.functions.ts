import { createServerFn } from "@tanstack/react-start";

/**
 * ATTRIBUTION — owned by the lead record, never by the accounts ledger.
 *
 * The ledger's `Source of Student` is keyed by an accounts person after the
 * fact. Tested against the leads' own utm_source it disagrees on 93% of sales
 * (924 disagree vs 65 agree) and is blank on 30% of L1. It is stored as
 * `source_of_student_raw` for reference only and is never used in any
 * calculation on any screen.
 *
 * Positive attribution only: a sale counts as performance marketing ONLY when
 * its email matches a lead record carrying paid-traffic markers. Everything
 * else is NOT_ATTRIBUTABLE_TO_PAID. That excludes podcast, organic and
 * word-of-mouth without classifying any of them, and cannot be gamed by a
 * mis-keyed label.
 *
 * Join key: lowercased, trimmed email.
 */

export type BucketRow = {
  bucket: "PAID" | "LEAD_NOT_PAID" | "NO_LEAD_RECORD" | string;
  buyers: number | string;
  sales: number | string;
  collected: number | string;
};

export type PlatformRow = {
  platform: string;
  is_paid: boolean;
  buyers: number | string;
  sales: number | string;
  collected: number | string;
};

export type CampaignRow = {
  utm_campaign: string | null;
  platform: string;
  is_paid: boolean;
  buyers: number | string;
  sales: number | string;
  collected: number | string;
};

export type CoverageRow = {
  buyers: number | string;
  matched: number | string;
  unmatched: number | string;
  coverage_pct: number | string | null;
  with_campaign: number | string;
  campaign_pct: number | string | null;
  leads_total: number | string;
};

export type UnmatchedBuyer = {
  email_key: string;
  email_raw: string | null;
  payer_name: string | null;
  first_date: string | null;
  last_date: string | null;
  sales: number | string;
  collected: number | string;
  rows_count: number | string;
};

export type AttributionData = {
  since: string;
  until: string;
  hasLeads: boolean;
  buckets: BucketRow[];
  platforms: PlatformRow[];
  campaigns: CampaignRow[];
  coverage: CoverageRow | null;
  error: string | null;
};

export const getAttribution = createServerFn({ method: "GET" })
  .inputValidator((data: { since?: string; until?: string; tier?: string }) => data ?? {})
  .handler(async ({ data }): Promise<AttributionData> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const since = data.since ?? "2026-01-01";
    const until = data.until ?? new Date().toISOString().slice(0, 10);
    const tier = data.tier ?? "L1_SILVER";
    const empty: AttributionData = {
      since,
      until,
      hasLeads: false,
      buckets: [],
      platforms: [],
      campaigns: [],
      coverage: null,
      error: null,
    };
    const pg = getPg();
    if (!pg) return empty;
    const args = { p_start: since, p_end: until, p_tier: tier };
    try {
      const [buckets, platforms, campaigns, coverage] = await Promise.all([
        pgRpc<BucketRow[]>(pg, "ledger_attribution_buckets", args),
        pgRpc<PlatformRow[]>(pg, "ledger_platform_rollup", args),
        pgRpc<CampaignRow[]>(pg, "ledger_campaign_rollup", args),
        pgRpc<CoverageRow[]>(pg, "ledger_lead_coverage", args),
      ]);
      const cov = coverage[0] ?? null;
      return {
        since,
        until,
        hasLeads: Number(cov?.leads_total ?? 0) > 0,
        buckets,
        platforms,
        campaigns,
        coverage: cov,
        error: null,
      };
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : String(error) };
    }
  });


export type NoLeadBuyer = {
  email_key: string;
  email_raw: string | null;
  payer_name: string | null;
  first_date: string | null;
  last_date: string | null;
  sales: number;
  collected: number;
  rows_count: number;
  bucket: string;
  phone: string | null;
  decision: string | null;
};

export type NoLeadSummary = {
  lead_history_start: string | null;
  total: number;
  sales: number;
  collected: number;
  buckets: Record<string, number>;
  decided: number;
};

/** Buyers with no lead record, sorted into why-they-are-missing groups. */
export const getNoLeadBuyers = createServerFn({ method: "GET" })
  .inputValidator((data: { since?: string; until?: string }) => data ?? {})
  .handler(
    async ({
      data,
    }): Promise<{ rows: NoLeadBuyer[]; summary: NoLeadSummary | null; error: string | null }> => {
      const { getPg, pgRpc } = await import("./pg.server");
      const pg = getPg();
      if (!pg) return { rows: [], summary: null, error: null };
      const args = {
        p_since: data.since ?? "2026-01-01",
        p_until: data.until ?? new Date().toISOString().slice(0, 10),
      };
      try {
        const [rows, summary] = await Promise.all([
          pgRpc<NoLeadBuyer[]>(pg, "nolead_buyer_rows", args),
          pgRpc<NoLeadSummary>(pg, "nolead_buyer_summary", args),
        ]);
        return { rows: rows ?? [], summary: summary ?? null, error: null };
      } catch (error) {
        return {
          rows: [],
          summary: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

/** Records one decision across a whole group at once. Never changes any figure. */
export const classifyNoLeadBuyers = createServerFn({ method: "POST" })
  .inputValidator((data: { emails: string[]; bucket: string; decision: string; note?: string }) => {
    if (!Array.isArray(data?.emails) || data.emails.length === 0) throw new Error("No buyers given");
    if (!data.decision) throw new Error("No decision given");
    return data;
  })
  .handler(async ({ data }): Promise<{ written: number; error: string | null }> => {
    const { getPg, pgUpsert } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { written: 0, error: "Backend not configured" };
    try {
      const now = new Date().toISOString();
      const payload = data.emails.slice(0, 5000).map((email_key) => ({
        email_key,
        bucket: data.bucket,
        decision: data.decision,
        note: data.note ?? null,
        decided_by: "owner",
        updated_at: now,
      }));
      await pgUpsert(pg, "buyer_classification", payload, "email_key");
      return { written: payload.length, error: null };
    } catch (error) {
      return { written: 0, error: error instanceof Error ? error.message : String(error) };
    }
  });

export type UtmSourceRule = {
  raw: string;
  platform: string;
  is_paid: boolean;
  note: string | null;
};

export const getUtmSourceMap = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ rules: UtmSourceRule[]; unmapped: { raw: string; leads: number }[] }> => {
    const { getPg, pgSelect } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { rules: [], unmapped: [] };
    const rules = await pgSelect<UtmSourceRule[]>(
      pg,
      "/utm_source_map?select=raw,platform,is_paid,note&order=raw",
    );
    const known = new Set(rules.map((r) => r.raw));
    const leads = await pgSelect<{ utm_source: string | null }[]>(
      pg,
      "/leads?select=utm_source&limit=20000",
    );
    const counts = new Map<string, number>();
    for (const l of leads) {
      const raw = (l.utm_source ?? "").trim().toLowerCase();
      if (raw === "" || known.has(raw)) continue;
      counts.set(raw, (counts.get(raw) ?? 0) + 1);
    }
    return {
      rules,
      unmapped: [...counts.entries()]
        .map(([raw, n]) => ({ raw, leads: n }))
        .sort((a, b) => b.leads - a.leads),
    };
  },
);

export const saveUtmSourceRule = createServerFn({ method: "POST" })
  .inputValidator((data: { raw: string; platform: string; is_paid: boolean; note?: string }) => ({
    raw: String(data.raw ?? "")
      .trim()
      .toLowerCase(),
    platform: ["meta", "google", "zoom", "organic", "podcast", "unknown"].includes(data.platform)
      ? data.platform
      : "unknown",
    is_paid: Boolean(data.is_paid),
    note: data.note?.trim() ? data.note.trim() : null,
  }))
  .handler(async ({ data }) => {
    const { getPg, pgUpsert } = await import("./pg.server");
    const pg = getPg();
    if (!pg) throw new Error("Database is not configured");
    if (!data.raw) throw new Error("A tracking value is required");
    await pgUpsert(pg, "utm_source_map", { ...data, updated_at: new Date().toISOString() });
    return { ok: true };
  });
