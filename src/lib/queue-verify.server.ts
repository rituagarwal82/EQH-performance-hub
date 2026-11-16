/**
 * Review-queue auto-verification.
 *
 * Every open review item states a condition. This pass re-checks each
 * condition against live data and closes only the items that verifiably pass
 * now, with the evidence of the re-check written into the resolution note.
 * Anything that needs a human judgement (machine tags, concept proposals,
 * a missing transcript) is never closed here — it is kept and reported.
 */

import { pgRpc, pgSelect, pgUpdate, type PgClient } from "./pg.server";
import type { ReviewItem } from "./review.server";

export type VerifyOutcome = {
  id: string;
  kind: string;
  ref_id: string | null;
  title: string;
  decision: "closed" | "kept";
  reason: string;
};

async function goldenPasses(pg: PgClient, goldenId: string) {
  // One golden at a time: the full sweep exceeds the statement timeout.
  const res = await pgRpc<{ pass?: boolean; computed?: number; expected?: number } | null>(
    pg,
    "run_golden",
    { p_golden_id: goldenId, p_trigger: "manual" },
  );
  const row = (res ?? {}) as Record<string, unknown>;
  return {
    pass: row["pass"] === true,
    computed: row["computed"] as number | undefined,
    expected: row["expected"] as number | undefined,
  };
}

async function verifyGoldenFailure(pg: PgClient, item: ReviewItem): Promise<VerifyOutcome> {
  const failing = await pgSelect<{ golden_id: string }[]>(
    pg,
    `/golden_tests?select=golden_id&order=golden_id.asc`,
  );
  const ids = (failing ?? []).map((r) => r.golden_id);
  const stillFailing: string[] = [];
  const nowPassing: string[] = [];
  for (const id of ids) {
    try {
      let r = await goldenPasses(pg, id);
      if (!r.pass && r.computed === undefined) r = await goldenPasses(pg, id);
      if (r.pass) nowPassing.push(id);
      else stillFailing.push(`${id} (expected ${r.expected ?? "?"}, got ${r.computed ?? "?"})`);
    } catch (e) {
      stillFailing.push(`${id} (could not run: ${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (stillFailing.length === 0) {
    return close(item, `all ${nowPassing.length} verified figures reproduce on re-run`);
  }
  await pgUpdate(pg, "review_items", `id=eq.${item.id}`, {
    detail: `Re-checked ${new Date().toISOString().slice(0, 10)}. Still not reproducing: ${stillFailing.join("; ")}.`,
    evidence: { ...item.evidence, rechecked_at: new Date().toISOString(), still_failing: stillFailing },
  });
  return keep(item, `${stillFailing.length} figure(s) still do not reproduce: ${stillFailing.join("; ")}`);
}

async function verifySourceDisagreement(pg: PgClient, item: ReviewItem): Promise<VerifyOutcome> {
  const [checkId, forDate] = (item.ref_id ?? "").split(":");
  if (!checkId || !forDate) return keep(item, "item carries no check/date reference to re-check");
  const rows = await pgSelect<{ verdict: string; divergence_pct: number | null; checked_at: string }[]>(
    pg,
    `/reconciliations?select=verdict,divergence_pct,checked_at&check_id=eq.${encodeURIComponent(checkId)}&for_date=eq.${forDate}&order=checked_at.desc&limit=1`,
  );
  const latest = rows?.[0];
  if (!latest) return keep(item, "no fresh check has run for that day yet");
  if (latest.verdict === "match") {
    return close(
      item,
      `${checkId} on ${forDate} now agrees across sources (checked ${latest.checked_at.slice(0, 16)})`,
    );
  }
  return keep(item, `${checkId} on ${forDate} still ${latest.verdict} (${latest.divergence_pct ?? "?"}%)`);
}

async function verifyWatchdog(pg: PgClient, item: ReviewItem): Promise<VerifyOutcome> {
  const checkId = item.ref_id ?? "";
  const reg = await pgSelect<{ fp_budget_per_30d: number }[]>(
    pg,
    `/proof_registry?select=fp_budget_per_30d&check_id=eq.${encodeURIComponent(checkId)}&limit=1`,
  );
  const budget = reg?.[0]?.fp_budget_per_30d ?? 0;
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const rows = await pgSelect<{ for_date: string; verdict: string }[]>(
    pg,
    `/reconciliations?select=for_date,verdict&check_id=eq.${encodeURIComponent(checkId)}&for_date=gte.${since}&limit=2000`,
  );
  const fires = (rows ?? []).filter((r) => r.verdict === "diverged").length;
  if (fires <= budget) {
    await pgUpdate(pg, "proof_registry", `check_id=eq.${encodeURIComponent(checkId)}`, {
      needs_recalibration: false,
      recalibrated_at: new Date().toISOString(),
    });
    return close(
      item,
      `${fires} fire(s) in the last 30 days against a budget of ${budget} — back in service`,
    );
  }
  return keep(item, `still noisy: ${fires} fire(s) in 30 days against a budget of ${budget}`);
}

async function verifyTranscriptMissing(pg: PgClient, item: ReviewItem): Promise<VerifyOutcome> {
  const code = item.ref_id ?? "";
  const rows = await pgSelect<{ script_text: string | null }[]>(
    pg,
    `/creative_scripts?select=script_text&script_code=eq.${encodeURIComponent(code)}&limit=1`,
  );
  const text = rows?.[0]?.script_text ?? "";
  if (text.trim().length > 200) return close(item, `${code} now carries a transcript (${text.trim().length} characters)`);
  return keep(item, `${code} still has no transcript text — only the owner can supply it`);
}

async function verifyConceptProposal(pg: PgClient, item: ReviewItem): Promise<VerifyOutcome> {
  const scripts = (item.evidence?.["scripts"] as unknown[] | undefined) ?? [];
  const ref = item.ref_id ?? "";
  const rows = await pgSelect<{ concept_id: string }[]>(
    pg,
    `/concepts?select=concept_id&concept_id=eq.${encodeURIComponent(ref)}&limit=1`,
  );
  if (rows?.[0]) return close(item, `concept ${ref} already exists in the ledger`);
  return keep(
    item,
    `proposal for ${ref}${scripts.length ? ` (${scripts.length} script(s))` : ""} — opening a concept is the owner's call`,
  );
}

async function verifyScriptTags(pg: PgClient, item: ReviewItem): Promise<VerifyOutcome> {
  const scriptId = item.ref_id ?? "";
  const rows = await pgSelect<{ confirmed: boolean }[]>(
    pg,
    `/script_tags?select=confirmed&script_id=eq.${encodeURIComponent(scriptId)}&limit=1`,
  );
  if (rows?.[0]?.confirmed) return close(item, "tags already confirmed on the script record");
  return keep(item, "machine-read tags still unconfirmed — needs a human read");
}

function verifyContractDrift(item: ReviewItem): VerifyOutcome {
  // The drift check itself re-raises items, so it is not safe to re-run here.
  // A drifted definition only clears when the owner approves a new version.
  return keep(
    item,
    `${item.ref_id ?? "this figure"} is calculated differently from its recorded definition — clearing it needs the owner to approve a new version`,
  );
}

function close(item: ReviewItem, reason: string): VerifyOutcome {
  return { id: item.id, kind: item.kind, ref_id: item.ref_id, title: item.title, decision: "closed", reason };
}
function keep(item: ReviewItem, reason: string): VerifyOutcome {
  return { id: item.id, kind: item.kind, ref_id: item.ref_id, title: item.title, decision: "kept", reason };
}

export async function verifyOpenReviewItems(pg: PgClient) {
  const items =
    (await pgSelect<ReviewItem[]>(
      pg,
      `/review_items?select=*&status=eq.open&order=kind.asc,created_at.asc&limit=500`,
    )) ?? [];

  const outcomes: VerifyOutcome[] = [];
  for (const item of items) {
    let outcome: VerifyOutcome;
    try {
      switch (item.kind) {
        case "golden_failure":
          outcome = await verifyGoldenFailure(pg, item);
          break;
        case "source_disagreement":
          outcome = await verifySourceDisagreement(pg, item);
          break;
        case "watchdog_recalibration":
          outcome = await verifyWatchdog(pg, item);
          break;
        case "script_transcript_missing":
          outcome = await verifyTranscriptMissing(pg, item);
          break;
        case "concept_proposal":
          outcome = await verifyConceptProposal(pg, item);
          break;
        case "script_tags":
          outcome = await verifyScriptTags(pg, item);
          break;
        case "contract_drift":
          outcome = verifyContractDrift(item);
          break;
        default:
          outcome = keep(item, "no automatic re-check exists for this kind");
      }
    } catch (e) {
      outcome = keep(item, `re-check failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (outcome.decision === "closed") {
      await pgUpdate(pg, "review_items", `id=eq.${item.id}`, {
        status: "confirmed",
        resolved_note: `Auto-verified: ${outcome.reason}`,
        resolved_at: new Date().toISOString(),
      });
    } else {
      // An item that stays open must say WHY it stayed open, every pass.
      // A queue of items with no recorded reason is indistinguishable from a
      // queue nobody re-checked.
      await pgUpdate(pg, "review_items", `id=eq.${item.id}`, {
        evidence: {
          ...(item.evidence ?? {}),
          last_recheck_at: new Date().toISOString(),
          last_recheck_result: `Still open: ${outcome.reason}`,
        },
        updated_at: new Date().toISOString(),
      });
    }
    outcomes.push(outcome);

  }

  return {
    checked: outcomes.length,
    closed: outcomes.filter((o) => o.decision === "closed").length,
    kept: outcomes.filter((o) => o.decision === "kept").length,
    outcomes,
  };
}
