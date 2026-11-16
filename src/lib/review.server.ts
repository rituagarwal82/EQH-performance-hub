/**
 * The review queue writer.
 *
 * Every automated judgement in the creative layer ends here as a proposal a
 * human confirms or rejects. Nothing in this file changes spend, state or a
 * mapping by itself — it only asks.
 */

import { pgSelect, pgUpsert, type PgClient } from "./pg.server";

export type ReviewKind =
  | "script_transcript_missing"
  | "script_tags"
  | "concept_proposal"
  | "concept_transition"
  | "concept_concurrency"
  | "source_disagreement"
  | "job_failure"
  | "owner_action"
  | "watchdog_recalibration";


export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type ReviewItem = {
  id: string;
  kind: ReviewKind | string;
  ref_id: string | null;
  title: string;
  detail: string | null;
  evidence: Record<string, JsonValue>;
  status: "open" | "confirmed" | "rejected";
  created_at: string;
};

/**
 * Raise an item once. A second call with the same kind + ref_id while the
 * first is still open refreshes its evidence instead of stacking duplicates.
 */
export async function raiseReviewItem(
  pg: PgClient,
  item: {
    kind: ReviewKind;
    refId: string;
    title: string;
    detail?: string | null;
    evidence?: Record<string, unknown>;
  },
): Promise<"created" | "refreshed"> {
  const existing = await pgSelect<{ id: string }[]>(
    pg,
    `/review_items?select=id&status=eq.open&kind=eq.${encodeURIComponent(item.kind)}&ref_id=eq.${encodeURIComponent(item.refId)}&limit=1`,
  );
  const row = {
    kind: item.kind,
    ref_id: item.refId,
    title: item.title,
    detail: item.detail ?? null,
    evidence: item.evidence ?? {},
    status: "open",
  };
  if (existing?.[0]?.id) {
    await pgUpsert(pg, "review_items", { ...row, id: existing[0].id });
    return "refreshed";
  }
  await pgUpsert(pg, "review_items", row);
  return "created";
}

export async function openItems(pg: PgClient, kind?: ReviewKind): Promise<ReviewItem[]> {
  const k = kind ? `&kind=eq.${encodeURIComponent(kind)}` : "";
  return (
    (await pgSelect<ReviewItem[]>(
      pg,
      `/review_items?select=*&status=eq.open${k}&order=created_at.desc&limit=500`,
    )) ?? []
  );
}
