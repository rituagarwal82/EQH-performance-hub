/**
 * PROPOSED ad → script links.
 *
 * Nothing here is applied. Every match lands in `script_link_proposals` with a
 * confidence and a plain sentence saying what it was matched on, and only the
 * owner's bulk confirmation writes it into `ad_script_map`. No verdict, ledger
 * or report reads a proposal.
 */

import { getPg, pgSelect, pgUpsert, type PgClient } from "./pg.server";
import { overlap } from "./script-match.server";

/**
 * A script code inside an ad name is often glued to other words with
 * underscores or pipes ("Ad 21 | 26th Aug | G3", "TOF_G4_scale"), so the code is
 * looked for on its own between any non-alphanumeric characters.
 */
function hasCode(text: string, code: string): boolean {
  const c = code.replace(/[^a-z0-9]/gi, "");
  if (!c) return false;
  return new RegExp(`(^|[^a-z0-9])${c}([^a-z0-9]|$)`, "i").test(text);
}
import { safeMessage } from "./safe-error";

type ScriptRow = { id: string; script_code: string; title: string | null };
type Candidate = {
  entity_id: string;
  ad_name: string | null;
  creative_title: string | null;
  creative_body: string | null;
};

export type ProposalBuild = {
  candidates: number;
  proposed: number;
  byBasis: Record<string, number>;
  high: number; // ≥ 0.9
  medium: number; // 0.8 – 0.89
  low: number; // < 0.8
  error: string | null;
};

const BASIS_TEXT: Record<string, string> = {
  ad_name_code: "script code in the ad name",
  creative_code: "script code in the ad's headline or body text",
  parent_code: "script code in the ad set or campaign name",
  title_words: "wording matches the script title",
};

async function parentNames(pg: PgClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const chunk = 200;
  const adRows: { entity_id: string; parent_id: string | null }[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const list = ids.slice(i, i + chunk).map(encodeURIComponent).join(",");
    const rows = await pgSelect<{ entity_id: string; parent_id: string | null }[]>(
      pg,
      `/ad_entities?select=entity_id,parent_id&entity_id=in.(${list})&limit=1000`,
    );
    adRows.push(...(rows ?? []));
  }
  const setIds = [...new Set(adRows.map((r) => r.parent_id).filter(Boolean) as string[])];
  const setRows: { entity_id: string; parent_id: string | null; name: string | null }[] = [];
  for (let i = 0; i < setIds.length; i += chunk) {
    const list = setIds.slice(i, i + chunk).map(encodeURIComponent).join(",");
    const rows = await pgSelect<typeof setRows>(
      pg,
      `/ad_entities?select=entity_id,parent_id,name&entity_id=in.(${list})&limit=1000`,
    );
    setRows.push(...(rows ?? []));
  }
  const campIds = [...new Set(setRows.map((r) => r.parent_id).filter(Boolean) as string[])];
  const campRows: { entity_id: string; name: string | null }[] = [];
  for (let i = 0; i < campIds.length; i += chunk) {
    const list = campIds.slice(i, i + chunk).map(encodeURIComponent).join(",");
    const rows = await pgSelect<typeof campRows>(
      pg,
      `/ad_entities?select=entity_id,name&entity_id=in.(${list})&limit=1000`,
    );
    campRows.push(...(rows ?? []));
  }
  const setById = new Map(setRows.map((r) => [r.entity_id, r]));
  const campById = new Map(campRows.map((r) => [r.entity_id, r.name ?? ""]));
  for (const ad of adRows) {
    const set = ad.parent_id ? setById.get(ad.parent_id) : undefined;
    const camp = set?.parent_id ? (campById.get(set.parent_id) ?? "") : "";
    out.set(ad.entity_id, `${set?.name ?? ""} ${camp}`.trim());
  }
  return out;
}

/** Rebuild the proposal list for ads that spent in the window and carry no script. */
export async function buildScriptProposals(days = 30): Promise<ProposalBuild> {
  const empty: ProposalBuild = {
    candidates: 0,
    proposed: 0,
    byBasis: {},
    high: 0,
    medium: 0,
    low: 0,
    error: null,
  };
  const pg = getPg();
  if (!pg) return { ...empty, error: "Backend not configured." };

  try {
    const { pgRpc } = await import("./pg.server");
    const [scripts, candidates, decided] = await Promise.all([
      pgSelect<ScriptRow[]>(pg, "/creative_scripts?select=id,script_code,title&limit=2000"),
      pgRpc<Candidate[]>(pg, "creative_unmapped_ads", { p_days: days }),
      pgSelect<{ ad_entity_id: string; status: string }[]>(
        pg,
        "/script_link_proposals?select=ad_entity_id,status&limit=20000",
      ),
    ]);

    const rejected = new Set(
      (decided ?? []).filter((d) => d.status !== "proposed").map((d) => d.ad_entity_id),
    );
    const byCode = new Map<string, ScriptRow>();
    for (const s of scripts ?? []) byCode.set(s.script_code.toUpperCase().replace(/\s+/g, ""), s);

    const ads = (candidates ?? []).filter((a) => !rejected.has(a.entity_id));
    const parents = await parentNames(
      pg,
      ads.map((a) => a.entity_id),
    );

    const rows: {
      ad_entity_id: string;
      script_id: string;
      confidence: number;
      basis: string;
      status: string;
    }[] = [];
    const byBasis: Record<string, number> = {};

    for (const ad of ads) {
      const name = ad.ad_name ?? "";
      const creative = `${ad.creative_title ?? ""} ${ad.creative_body ?? ""}`.trim();
      const parent = parents.get(ad.entity_id) ?? "";

      let hit: { script: ScriptRow; confidence: number; basis: string } | null = null;
      const tries: [string, string, number][] = [
        [name, "ad_name_code", 0.95],
        [creative, "creative_code", 0.9],
        [parent, "parent_code", 0.8],
      ];
      for (const [text, basis, confidence] of tries) {
        if (hit || !text) continue;
        for (const [code, s] of byCode) {
          if (hasCode(text, code)) {
            hit = { script: s, confidence, basis };
            break;
          }
        }
      }

      if (!hit) {
        let best: { script: ScriptRow; confidence: number; basis: string } | null = null;
        for (const s of scripts ?? []) {
          const target = s.title ?? s.script_code;
          const score = Math.max(overlap(target, name), overlap(target, creative));
          if (score >= 0.6 && (!best || score > best.confidence)) {
            best = { script: s, confidence: Number(score.toFixed(2)), basis: "title_words" };
          }
        }
        hit = best;
      }
      if (!hit) continue;

      rows.push({
        ad_entity_id: ad.entity_id,
        script_id: hit.script.id,
        confidence: hit.confidence,
        basis: BASIS_TEXT[hit.basis] ?? hit.basis,
        status: "proposed",
      });
      byBasis[BASIS_TEXT[hit.basis] ?? hit.basis] =
        (byBasis[BASIS_TEXT[hit.basis] ?? hit.basis] ?? 0) + 1;
    }

    for (let i = 0; i < rows.length; i += 300) {
      await pgUpsert(pg, "script_link_proposals", rows.slice(i, i + 300), "ad_entity_id");
    }

    return {
      candidates: ads.length,
      proposed: rows.length,
      byBasis,
      high: rows.filter((r) => r.confidence >= 0.9).length,
      medium: rows.filter((r) => r.confidence >= 0.8 && r.confidence < 0.9).length,
      low: rows.filter((r) => r.confidence < 0.8).length,
      error: null,
    };
  } catch (e) {
    return { ...empty, error: safeMessage(e) };
  }
}
