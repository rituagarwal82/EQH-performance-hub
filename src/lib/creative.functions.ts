import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeMessage } from "./safe-error";

/** Server functions behind the /creative screen. */

export type RegistryRow = {
  script_id: string;
  script_code: string;
  title: string | null;
  ads_mapped: number | string;
  spend: number | string;
  impressions: number | string;
  link_clicks: number | string;
  meta_leads: number | string;
  tracked_leads: number | string;
  attendees: number | string;
  attendees_60: number | string;
  low_conf_ads: number | string;
};

export type UnmappedAd = {
  entity_id: string;
  ad_name: string | null;
  account_id: string;
  creative_title: string | null;
  creative_body: string | null;
  thumbnail_url: string | null;
  spend: number | string;
  leads: number | string;
};

export type QueueRow = {
  ad_entity_id: string;
  ad_name: string | null;
  script_id: string;
  script_code: string;
  title: string | null;
  confidence: number | string;
  spend_30d: number | string;
};

export type Coverage = {
  ads_total: number | string;
  ads_active: number | string;
  with_body: number | string;
  with_title: number | string;
  fetch_failed: number | string;
  never_fetched: number | string;
};

export type ScriptOption = { id: string; script_code: string; title: string | null };

export type CreativeData = {
  registry: RegistryRow[];
  unmapped: UnmappedAd[];
  queue: QueueRow[];
  coverage: Coverage | null;
  scripts: ScriptOption[];
  error: string | null;
};

export const getCreativeData = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ since: z.string(), until: z.string() }).parse(data))
  .handler(async ({ data }): Promise<CreativeData> => {
    const { getPg, pgRpc, pgSelect } = await import("./pg.server");
    const pg = getPg();
    const empty: CreativeData = {
      registry: [],
      unmapped: [],
      queue: [],
      coverage: null,
      scripts: [],
      error: null,
    };
    if (!pg) return empty;
    try {
      const [registry, unmapped, queue, coverage, scripts] = await Promise.all([
        pgRpc<RegistryRow[]>(pg, "creative_registry", { p_start: data.since, p_end: data.until }),
        pgRpc<UnmappedAd[]>(pg, "creative_unmapped_ads", { p_days: 30 }),
        pgRpc<QueueRow[]>(pg, "script_mapping_queue", {}),
        pgRpc<Coverage[]>(pg, "creative_text_coverage", {}),
        pgSelect<ScriptOption[]>(
          pg,
          "/creative_scripts?select=id,script_code,title&order=script_code.asc&limit=1000",
        ),
      ]);
      return {
        registry: registry ?? [],
        unmapped: unmapped ?? [],
        queue: queue ?? [],
        coverage: coverage?.[0] ?? null,
        scripts: scripts ?? [],
        error: null,
      };
    } catch (e) {
      return { ...empty, error: safeMessage(e) };
    }
  });

/** Attach a script to one ad: either an existing script or a newly pasted one. */
export const attachScript = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        adEntityId: z.string().min(1),
        scriptId: z.string().uuid().optional(),
        scriptCode: z.string().min(1).max(40).optional(),
        title: z.string().max(300).optional(),
        scriptText: z.string().min(1).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error: string | null }> => {
    const { getPg, pgRpc, pgSelect, pgUpsert } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { ok: false, error: "Backend not configured." };
    try {
      let scriptId = data.scriptId ?? null;
      if (!scriptId) {
        if (!data.scriptCode || !data.scriptText) {
          return { ok: false, error: "A new script needs both a code and its text." };
        }
        await pgRpc<number>(pg, "upsert_creative_scripts", {
          p_rows: [
            {
              script_code: data.scriptCode.trim(),
              title: data.title ?? null,
              script_text: data.scriptText,
              source: "manual",
            },
          ],
          p_source: "manual",
        });
        const found = await pgSelect<{ id: string }[]>(
          pg,
          `/creative_scripts?select=id&script_code=eq.${encodeURIComponent(data.scriptCode.trim())}&limit=1`,
        );
        scriptId = found?.[0]?.id ?? null;
        if (!scriptId) return { ok: false, error: "Script could not be stored." };
      }
      await pgUpsert(pg, "ad_script_map", {
        ad_entity_id: data.adEntityId,
        script_id: scriptId,
        mapped_by: "manual",
        confidence: 1,
      });
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: safeMessage(e) };
    }
  });

/** One-click confirm (promote to manual) or reject (drop) a queued auto match. */
export const resolveMapping = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ adEntityId: z.string().min(1), confirm: z.boolean() }).parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error: string | null }> => {
    const { getPg, pgDelete, pgUpdate } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { ok: false, error: "Backend not configured." };
    const filter = `ad_entity_id=eq.${encodeURIComponent(data.adEntityId)}`;
    try {
      if (data.confirm) {
        await pgUpdate(pg, "ad_script_map", filter, { mapped_by: "manual", confidence: 1 });
      } else {
        await pgDelete(pg, "ad_script_map", filter);
      }
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: safeMessage(e) };
    }
  });

export type CreativeSyncReport = {
  text: import("./creative-sync.server").CreativeTextResult | null;
  demo: import("./creative-sync.server").DemoResult | null;
  match: import("./script-match.server").MatchResult | null;
  error: string | null;
};

