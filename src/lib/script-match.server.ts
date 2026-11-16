/**
 * Ad name → script matcher.
 *
 * Two passes, in order of trust:
 *   1. SCRIPT CODE. Codes look like V1 / G4 / R6 and are stamped into ad names
 *      and utm_content values. An exact code token in the ad name is a strong
 *      match (0.95).
 *   2. TITLE OVERLAP. Dice coefficient over normalised word tokens of the
 *      script title against the ad name. Anything under 0.6 is NOT a match and
 *      is left alone.
 *
 * Nothing below 0.8 is treated as settled — those rows land in the script
 * mapping queue for one-click confirmation. A manual mapping is never
 * overwritten by the matcher.
 */

import { getPg, pgSelect, pgUpsert } from "./pg.server";
import { safeMessage } from "./safe-error";

const CODE_RE = /\b([vgr])\s*[-_ ]?\s*(\d{1,3})\b/gi;

function normalise(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(s: string) {
  return new Set(normalise(s).split(" ").filter((t) => t.length > 2));
}

/** Dice coefficient over word tokens — 0 to 1. */
export function overlap(a: string, b: string) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return (2 * hit) / (ta.size + tb.size);
}

/** All script-shaped codes present in a string, upper-cased ("V1", "G12"). */
export function codesIn(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(CODE_RE)) {
    out.push(`${m[1]!.toUpperCase()}${Number(m[2])}`);
  }
  return out;
}

export type MatchResult = {
  scripts: number;
  adsConsidered: number;
  matched: number;
  queued: number;
  unmatched: number;
  written: number;
  error: string | null;
};

type ScriptRow = { id: string; script_code: string; title: string | null };
type AdRow = { entity_id: string; name: string | null };
type MapRow = { ad_entity_id: string; mapped_by: string };

export async function runScriptMatch(): Promise<MatchResult> {
  const pg = getPg();
  const empty: MatchResult = {
    scripts: 0,
    adsConsidered: 0,
    matched: 0,
    queued: 0,
    unmatched: 0,
    written: 0,
    error: null,
  };
  if (!pg) return { ...empty, error: "Lovable Cloud backend is not configured for this project yet." };

  try {
    const [scripts, ads, existing] = await Promise.all([
      pgSelect<ScriptRow[]>(pg, "/creative_scripts?select=id,script_code,title&limit=2000"),
      pgSelect<AdRow[]>(pg, "/ad_entities?select=entity_id,name&level=eq.ad&limit=20000"),
      pgSelect<MapRow[]>(pg, "/ad_script_map?select=ad_entity_id,mapped_by&limit=20000"),
    ]);

    const manual = new Set((existing ?? []).filter((m) => m.mapped_by === "manual").map((m) => m.ad_entity_id));
    const byCode = new Map<string, ScriptRow>();
    for (const s of scripts ?? []) byCode.set(s.script_code.toUpperCase().replace(/\s+/g, ""), s);

    const rows: {
      ad_entity_id: string;
      script_id: string;
      mapped_by: string;
      confidence: number;
    }[] = [];
    let matched = 0;
    let queued = 0;
    let unmatched = 0;

    for (const ad of ads ?? []) {
      if (manual.has(ad.entity_id)) continue;
      const name = ad.name ?? "";
      if (!name) {
        unmatched += 1;
        continue;
      }

      let hit: { script: ScriptRow; confidence: number } | null = null;
      for (const code of codesIn(name)) {
        const s = byCode.get(code);
        if (s) {
          hit = { script: s, confidence: 0.95 };
          break;
        }
      }

      if (!hit) {
        let best: { script: ScriptRow; confidence: number } | null = null;
        for (const s of scripts ?? []) {
          const score = overlap(s.title ?? s.script_code, name);
          if (score >= 0.6 && (!best || score > best.confidence)) best = { script: s, confidence: score };
        }
        hit = best;
      }

      if (!hit) {
        unmatched += 1;
        continue;
      }
      rows.push({
        ad_entity_id: ad.entity_id,
        script_id: hit.script.id,
        mapped_by: "auto_name_match",
        confidence: Number(hit.confidence.toFixed(2)),
      });
      if (hit.confidence >= 0.8) matched += 1;
      else queued += 1;
    }

    let written = 0;
    for (let i = 0; i < rows.length; i += 300) {
      const batch = rows.slice(i, i + 300);
      await pgUpsert(pg, "ad_script_map", batch);
      written += batch.length;
    }

    return {
      scripts: (scripts ?? []).length,
      adsConsidered: (ads ?? []).length,
      matched,
      queued,
      unmatched,
      written,
      error: null,
    };
  } catch (e) {
    return { ...empty, error: safeMessage(e) };
  }
}
