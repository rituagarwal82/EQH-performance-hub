/**
 * The business knowledge Ask reads before it answers.
 *
 * Nothing here is hardcoded prose: the rules and standing findings live in
 * `ask_knowledge` (editable), beside the owner's own Decisions & Rules rows and
 * the live source dictionary. A rule that changes on the Rules page changes the
 * answer on the next question, with no code edit.
 */

import { getPg, pgSelect, pgRpc } from "./pg.server";

export type KnowledgeRow = { topic: string; kind: string; body: string };
type RulingRow = { section: string; title: string; body: string };
type DictRow = { channel_group: string; display_name: string | null; is_paid: boolean | null };

export type FeedState = {
  feed: string;
  label: string;
  status: string;
  coverage_edge: string | null;
  last_success: string | null;
  hours_since_success: number | string | null;
};

export type Knowledge = {
  rows: KnowledgeRow[];
  rulings: RulingRow[];
  sources: string[];
  feeds: FeedState[];
};

export async function loadKnowledge(): Promise<Knowledge> {
  const pg = getPg();
  const empty: Knowledge = { rows: [], rulings: [], sources: [], feeds: [] };
  if (!pg) return empty;

  const [rows, rulings, dict, feeds] = await Promise.all([
    pgSelect<KnowledgeRow[]>(
      pg,
      "/ask_knowledge?select=topic,kind,body&is_active=eq.true&order=ord.asc&limit=80",
    ).catch(() => [] as KnowledgeRow[]),
    pgSelect<RulingRow[]>(
      pg,
      "/owner_rulings?select=section,title,body&is_active=eq.true&order=section.asc,ord.asc&limit=60",
    ).catch(() => [] as RulingRow[]),
    pgSelect<DictRow[]>(
      pg,
      "/source_dictionary?select=channel_group,display_name,is_paid&order=channel_group.asc&limit=300",
    ).catch(() => [] as DictRow[]),
    pgRpc<FeedState[]>(pg, "feed_health_rows", {}).catch(() => [] as FeedState[]),
  ]);

  const seen = new Map<string, boolean>();
  for (const d of dict ?? []) {
    if (!d.channel_group) continue;
    if (!seen.has(d.channel_group)) seen.set(d.channel_group, Boolean(d.is_paid));
  }
  const sources = [...seen.entries()].map(([g, paid]) => `${g}${paid ? " (paid)" : " (not paid)"}`);

  return {
    rows: rows ?? [],
    rulings: rulings ?? [],
    sources,
    feeds: (feeds ?? []).map((f) => ({
      feed: f.feed,
      label: f.label,
      status: f.status,
      coverage_edge: f.coverage_edge,
      last_success: f.last_success,
      hours_since_success: f.hours_since_success,
    })),
  };
}

/** Compact, readable block for the model — rules first, findings after. */
export function knowledgeBlock(k: Knowledge): string {
  const lines: string[] = [];
  lines.push("HOW THIS BUSINESS COUNTS THINGS (these rules win over any assumption):");
  for (const r of k.rows) lines.push(`- [${r.kind}] ${r.topic}: ${r.body}`);
  if (k.rulings.length) {
    lines.push("", "OWNER DECISIONS ON RECORD:");
    for (const r of k.rulings) lines.push(`- ${r.section} — ${r.title}: ${r.body}`);
  }
  if (k.sources.length) {
    lines.push("", `TRAFFIC SOURCE GROUPS IN USE: ${k.sources.join("; ")}`);
  }
  return lines.join("\n");
}

export function freshnessBlock(k: Knowledge): string {
  if (!k.feeds.length) return "FEED FRESHNESS: not available right now.";
  const lines = k.feeds.map(
    (f) =>
      `- ${f.label} (${f.feed}): ${f.status}; data reaches ${f.coverage_edge ?? "unknown"}; last successful read ${f.last_success ?? "never"}.`,
  );
  return ["FEED FRESHNESS (state the relevant one whenever it bears on the answer):", ...lines].join(
    "\n",
  );
}
