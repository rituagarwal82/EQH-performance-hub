import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { safeMessage } from "./safe-error";

/** The one confirmation list on the Creative screen: proposed links + pending tags. */

export type ProposalRow = {
  ad_entity_id: string;
  ad_name: string | null;
  account_id: string | null;
  thumbnail_url: string | null;
  permalink_url: string | null;
  script_id: string;
  script_code: string;
  title: string | null;
  confidence: number | string;
  basis: string;
  spend_30d: number | string;
  leads_30d: number | string;
};

export type PendingTag = {
  script_id: string;
  script_code: string;
  title: string | null;
  persona: string;
  pain: string;
  hook_mechanism: string;
  promise: string;
};

export type MoneyCoverage = {
  ads_spent: number | string;
  ads_mapped: number | string;
  spend_total: number | string;
  spend_mapped: number | string;
};

export type ExampleAd = {
  script_id: string;
  entity_id: string;
  account_id: string | null;
  thumbnail_url: string | null;
  permalink_url: string | null;
};

export type ProposalData = {
  proposals: ProposalRow[];
  pendingTags: PendingTag[];
  coverage: MoneyCoverage | null;
  examples: ExampleAd[];
  error: string | null;
};

export const getScriptProposals = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProposalData> => {
    const { getPg, pgRpc, pgSelect } = await import("./pg.server");
    const pg = getPg();
    const empty: ProposalData = {
      proposals: [],
      pendingTags: [],
      coverage: null,
      examples: [],
      error: null,
    };
    if (!pg) return empty;
    try {
      const [proposals, coverage, examples, tags] = await Promise.all([
        pgRpc<ProposalRow[]>(pg, "script_link_proposal_rows", {}),
        pgRpc<MoneyCoverage[]>(pg, "creative_money_coverage", { p_days: 30 }),
        pgRpc<ExampleAd[]>(pg, "script_example_ads", { p_days: 30 }),
        pgSelect<
          {
            script_id: string;
            persona: string;
            pain: string;
            hook_mechanism: string;
            promise: string;
            creative_scripts: { script_code: string; title: string | null } | null;
          }[]
        >(
          pg,
          "/script_tags?select=script_id,persona,pain,hook_mechanism,promise,creative_scripts(script_code,title)&confirmed=is.false&limit=500",
        ),
      ]);
      return {
        proposals: proposals ?? [],
        coverage: coverage?.[0] ?? null,
        examples: examples ?? [],
        pendingTags: (tags ?? []).map((t) => ({
          script_id: t.script_id,
          script_code: t.creative_scripts?.script_code ?? t.script_id.slice(0, 8),
          title: t.creative_scripts?.title ?? null,
          persona: t.persona,
          pain: t.pain,
          hook_mechanism: t.hook_mechanism,
          promise: t.promise,
        })),
        error: null,
      };
    } catch (e) {
      return { ...empty, error: safeMessage(e) };
    }
  },
);

/** Recompute the proposals from stored creative text, ad names and campaign naming. */
export const refreshScriptProposals = createServerFn({ method: "POST" }).handler(async () => {
  const { buildScriptProposals } = await import("./script-proposals.server");
  return buildScriptProposals(30);
});

/** Bulk confirm or reject proposed links. Confirming is the only write to ad_script_map. */
export const decideProposals = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({ adEntityIds: z.array(z.string().min(1)).min(1).max(500), confirm: z.boolean() })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; applied: number; error: string | null }> => {
    const { getPg, pgSelect, pgUpdate, pgUpsert } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { ok: false, applied: 0, error: "Backend not configured." };
    try {
      const list = data.adEntityIds.map(encodeURIComponent).join(",");
      const rows = await pgSelect<{ ad_entity_id: string; script_id: string }[]>(
        pg,
        `/script_link_proposals?select=ad_entity_id,script_id&ad_entity_id=in.(${list})&limit=1000`,
      );
      if (data.confirm && (rows ?? []).length > 0) {
        await pgUpsert(
          pg,
          "ad_script_map",
          (rows ?? []).map((r) => ({
            ad_entity_id: r.ad_entity_id,
            script_id: r.script_id,
            mapped_by: "manual",
            confidence: 1,
          })),
          "ad_entity_id",
        );
      }
      await pgUpdate(pg, "script_link_proposals", `ad_entity_id=in.(${list})`, {
        status: data.confirm ? "confirmed" : "rejected",
        decided_at: new Date().toISOString(),
      });
      return { ok: true, applied: (rows ?? []).length, error: null };
    } catch (e) {
      return { ok: false, applied: 0, error: safeMessage(e) };
    }
  });

/** Confirm the machine-written script tags waiting in the same list. */
export const confirmScriptTags = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ scriptIds: z.array(z.string().uuid()).min(1).max(200) }).parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error: string | null }> => {
    const { getPg, pgUpdate } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { ok: false, error: "Backend not configured." };
    try {
      const list = data.scriptIds.map(encodeURIComponent).join(",");
      await pgUpdate(pg, "script_tags", `script_id=in.(${list})`, { confirmed: true });
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: safeMessage(e) };
    }
  });
