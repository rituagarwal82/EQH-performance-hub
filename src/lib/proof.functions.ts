import { createServerFn } from "@tanstack/react-start";

/**
 * Reads for the proof layer. A check that has not run is never rendered as a
 * pass: absence of verification must show as absence, not as a tick.
 */
export type ProofStatus =
  | "match"
  | "diverged"
  | "stale"
  | "unverified"
  | "never_run"
  | "recalibrating";

export type ProofSummaryRow = {
  check_id: string;
  label: string;
  plain: string;
  primary_source: string | null;
  witness_source: string | null;
  last_run: string | null;
  hours_since: number | string | null;
  days_checked: number;
  matches: number;
  tolerable: number;
  diverged: number;
  unavailable: number;
  worst_date: string | null;
  worst_divergence: number | string | null;
  worst_primary: number | string | null;
  worst_witness: number | string | null;
  worst_note: string | null;
  status: ProofStatus;
  family: "proof" | "invariant" | "golden" | "contract";
  expected_noise: string;
  fp_budget_per_30d: number | string;
  tolerance_note: string | null;
  structural_note: string | null;
  needs_recalibration: boolean;
  diverged_30d: number;
};

/** One cell of the 30-day history strip. */
export type ProofHistoryCell = {
  check_id: string;
  for_date: string;
  verdict: "match" | "tolerable" | "diverged" | "witness_unavailable";
};

export type ProofDetailRow = {
  check_id: string;
  for_date: string;
  checked_at: string;
  primary_value: number | string | null;
  primary_source: string;
  witness_value: number | string | null;
  witness_source: string;
  divergence_pct: number | string | null;
  verdict: "match" | "tolerable" | "diverged" | "witness_unavailable";
  note: string | null;
};

export type ProofData = {
  configured: boolean;
  checks: ProofSummaryRow[];
  detail: ProofDetailRow[];
  history: ProofHistoryCell[];
  error: string | null;
};

export async function readProof(days: number): Promise<ProofData> {
  const { getPg, pgRpc } = await import("./pg.server");
  const empty: ProofData = { configured: false, checks: [], detail: [], history: [], error: null };
  const pg = getPg();
  if (!pg) return empty;
  try {
    const checks = await pgRpc<ProofSummaryRow[]>(pg, "proof_summary", {});
    const detail = await pgRpc<ProofDetailRow[]>(pg, "proof_detail", { p_days: days });
    const history = await pgRpc<ProofHistoryCell[]>(pg, "proof_history_strip", { p_days: 30 });
    return {
      configured: true,
      checks: checks ?? [],
      detail: detail ?? [],
      history: history ?? [],
      error: null,
    };
  } catch (error) {
    return {
      ...empty,
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const getProof = createServerFn({ method: "GET" })
  .inputValidator((input: { days?: number } | undefined) => ({ days: input?.days ?? 14 }))
  .handler(({ data }) => readProof(data.days));

/** Owner-triggered re-run of all five checks. */
export const runProofNow = createServerFn({ method: "POST" })
  .inputValidator((input: { since?: string | null; until?: string | null } | undefined) => ({
    since: input?.since ?? null,
    until: input?.until ?? null,
  }))
  .handler(async ({ data }) => {
    const { runProofChecks } = await import("./proof.server");
    return runProofChecks({ since: data.since, until: data.until, source: "proof" });
  });
