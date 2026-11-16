/**
 * DECISIONS & RULES — the owner's own rulebook, held inside the app.
 *
 * Two kinds of entry live on that page:
 *   TYPED      — rulings the owner wrote, stored in `owner_rulings`, editable
 *                here, with every change written to `owner_ruling_changes`.
 *   AUTOMATIC  — facts the engine already holds (ad-account ownership periods,
 *                named collaboration/podcast/talk sources, team holds,
 *                connection expiry, accounts whose tracking is not working).
 *                These are read live so the page can never drift from reality.
 */

import { createServerFn } from "@tanstack/react-start";

import { safeMessage } from "./safe-error";

export type Ruling = {
  id: string;
  section: string;
  ord: number;
  title: string;
  body: string;
  decided_by: string;
  decided_on: string | null;
  why: string | null;
  is_active: boolean;
  updated_at: string;
};

export type RulingChange = {
  id: string;
  ruling_id: string | null;
  action: string;
  changed_by: string | null;
  changed_at: string;
  after_value: { title?: string } | null;
};

export type OwnershipPeriod = {
  account_id: string;
  account_name: string | null;
  agency_code: string;
  valid_from: string;
  valid_to: string | null;
  note: string | null;
};

export type NamedSource = { channel_group: string; display_name: string };

export type AgencyHold = {
  agency_code: string;
  ratios_hold: boolean;
  ratios_hold_reason: string | null;
  ratios_valid_from: string | null;
};

export type Credential = {
  key: string;
  label: string;
  expires_at: string | null;
  what_breaks: string | null;
};

export type BlindSpotAccount = {
  account_id: string;
  name: string | null;
  agency_code: string | null;
  lead_tracking_status: string | null;
  account_role?: string | null;
};

export type RulesPayload = {
  configured: boolean;
  rulings: Ruling[];
  changes: RulingChange[];
  ownership: OwnershipPeriod[];
  namedSources: NamedSource[];
  holds: AgencyHold[];
  credentials: Credential[];
  blindSpots: BlindSpotAccount[];
  error: string | null;
};

const EMPTY: RulesPayload = {
  configured: false,
  rulings: [],
  changes: [],
  ownership: [],
  namedSources: [],
  holds: [],
  credentials: [],
  blindSpots: [],
  error: null,
};

const NAMED_GROUPS = ["Collaboration", "Influencer podcast", "Talks & offline events"];

export const getRules = createServerFn({ method: "GET" }).handler(async (): Promise<RulesPayload> => {
  const { getPg, pgSelect } = await import("./pg.server");
  const pg = getPg();
  if (!pg) return EMPTY;

  try {
    const groups = NAMED_GROUPS.map((g) => `"${g}"`).join(",");
    const [rulings, changes, ownership, dict, holds, credentials, accounts] = await Promise.all([
      pgSelect<Ruling[]>(
        pg,
        "/owner_rulings?select=id,section,ord,title,body,decided_by,decided_on,why,is_active,updated_at&is_active=eq.true&order=section.asc,ord.asc",
      ),
      pgSelect<RulingChange[]>(
        pg,
        "/owner_ruling_changes?select=id,ruling_id,action,changed_by,changed_at,after_value&order=changed_at.desc&limit=25",
      ).catch(() => []),
      pgSelect<{ account_id: string; agency_code: string; valid_from: string; valid_to: string | null; note: string | null }[]>(
        pg,
        "/ad_account_ownership?select=account_id,agency_code,valid_from,valid_to,note&order=account_id.asc,valid_from.asc",
      ).catch(() => []),
      pgSelect<NamedSource[]>(
        pg,
        `/source_dictionary?select=channel_group,display_name&valid_to=is.null&channel_group=in.(${encodeURIComponent(groups)})`,
      ).catch(() => []),
      pgSelect<AgencyHold[]>(
        pg,
        "/agency_spend_status?select=agency_code,ratios_hold,ratios_hold_reason,ratios_valid_from&order=agency_code.asc",
      ).catch(() => []),
      pgSelect<Credential[]>(
        pg,
        "/credential_register?select=key,label,expires_at,what_breaks&order=expires_at.asc.nullslast",
      ).catch(() => []),
      pgSelect<BlindSpotAccount[]>(
        pg,
        "/ad_accounts?select=account_id,name,agency_code,lead_tracking_status,account_role,is_active&is_active=eq.true",
      ).catch(() => []),
    ]);

    // Only accounts that are actually spending belong on the blind-spot list:
    // a dormant account with unconfirmed tracking costs nothing and hides
    // nothing. Retargeting/brand accounts are excluded by ruling.
    const since = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
    const spendRows = await pgSelect<{ account_id: string }[]>(
      pg,
      `/daily_metrics?select=account_id&level=eq.account&date=gte.${since}&spend=gt.0&limit=5000`,
    ).catch(() => []);
    const spending = new Set((spendRows ?? []).map((r) => r.account_id));

    const names = new Map((accounts ?? []).map((a) => [a.account_id, a.name]));

    const seen = new Set<string>();
    const namedSources: NamedSource[] = [];
    for (const row of dict ?? []) {
      const k = `${row.channel_group}|${row.display_name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      namedSources.push(row);
    }
    namedSources.sort(
      (a, b) =>
        a.channel_group.localeCompare(b.channel_group) ||
        a.display_name.localeCompare(b.display_name),
    );

    return {
      configured: true,
      rulings: rulings ?? [],
      changes: changes ?? [],
      ownership: (ownership ?? []).map((o) => ({ ...o, account_name: names.get(o.account_id) ?? null })),
      namedSources,
      holds: (holds ?? []).filter((h) => h.ratios_hold),
      credentials: credentials ?? [],
      blindSpots: (accounts ?? []).filter(
        (a) =>
          spending.has(a.account_id) &&
          a.account_role !== "retargeting_brand" &&
          (a.lead_tracking_status === "broken" || a.lead_tracking_status === "unknown"),
      ),
      error: null,
    };
  } catch (e) {
    return { ...EMPTY, configured: true, error: safeMessage(e) };
  }
});

export type SaveRulingInput = {
  id?: string | undefined;
  section: string;
  title: string;
  body: string;
  decided_by: string;
  decided_on: string | null;
  why: string | null;
  changed_by: string | null;
};

export const saveRuling = createServerFn({ method: "POST" })
  .inputValidator((d: SaveRulingInput) => d)
  .handler(async ({ data }): Promise<{ ok: boolean; error: string | null }> => {
    const { getPg, pgSelect, pgInsert, pgUpdate } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { ok: false, error: "The database is not connected." };

    const patch = {
      section: data.section,
      title: data.title.trim(),
      body: data.body.trim(),
      decided_by: data.decided_by.trim() || "Owner",
      decided_on: data.decided_on || null,
      why: data.why?.trim() || null,
      updated_at: new Date().toISOString(),
    };
    if (!patch.title || !patch.body) return { ok: false, error: "A rule needs a heading and wording." };

    try {
      if (data.id) {
        const before = await pgSelect<Ruling[]>(
          pg,
          `/owner_rulings?select=*&id=eq.${encodeURIComponent(data.id)}`,
        );
        await pgUpdate(pg, "owner_rulings", `id=eq.${encodeURIComponent(data.id)}`, patch);
        await pgInsert(pg, "owner_ruling_changes", {
          ruling_id: data.id,
          action: "edited",
          before_value: before?.[0] ?? null,
          after_value: patch,
          changed_by: data.changed_by,
        });
      } else {
        const rows = await pgInsert<{ id: string }[]>(pg, "owner_rulings", {
          ...patch,
          ord: 900,
        });
        await pgInsert(pg, "owner_ruling_changes", {
          ruling_id: rows?.[0]?.id ?? null,
          action: "added",
          after_value: patch,
          changed_by: data.changed_by,
        });
      }
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: safeMessage(e) };
    }
  });

export const retireRuling = createServerFn({ method: "POST" })
  .inputValidator((d: { id: string; changed_by: string | null }) => d)
  .handler(async ({ data }): Promise<{ ok: boolean; error: string | null }> => {
    const { getPg, pgSelect, pgInsert, pgUpdate } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { ok: false, error: "The database is not connected." };
    try {
      const before = await pgSelect<Ruling[]>(
        pg,
        `/owner_rulings?select=*&id=eq.${encodeURIComponent(data.id)}`,
      );
      await pgUpdate(pg, "owner_rulings", `id=eq.${encodeURIComponent(data.id)}`, {
        is_active: false,
        updated_at: new Date().toISOString(),
      });
      await pgInsert(pg, "owner_ruling_changes", {
        ruling_id: data.id,
        action: "retired",
        before_value: before?.[0] ?? null,
        changed_by: data.changed_by,
      });
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: safeMessage(e) };
    }
  });
