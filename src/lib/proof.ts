import { queryOptions } from "@tanstack/react-query";

import {
  getProof,
  type ProofData,
  type ProofHistoryCell,
  type ProofDetailRow,
  type ProofStatus,
  type ProofSummaryRow,
} from "./proof.functions";

export type { ProofData, ProofDetailRow, ProofHistoryCell, ProofStatus, ProofSummaryRow };

export const proofQuery = (days = 14) =>
  queryOptions({
    queryKey: ["proof", days],
    queryFn: () => getProof({ data: { days } }),
    refetchInterval: 300_000,
    staleTime: 120_000,
  });

export const PROOF_TONE: Record<ProofStatus, string> = {
  match: "bg-positive/15 text-positive",
  diverged: "bg-destructive/15 text-destructive",
  stale: "bg-warning/15 text-warning",
  unverified: "bg-muted text-muted-foreground",
  never_run: "bg-muted text-muted-foreground",
  recalibrating: "bg-warning/15 text-warning",
};

export const PROOF_LABEL: Record<ProofStatus, string> = {
  match: "agrees",
  diverged: "disagrees",
  stale: "check has not run",
  unverified: "nothing to check",
  never_run: "never run",
  recalibrating: "under review — miscalibrated",
};

export function proofOf(checks: ProofSummaryRow[] | undefined, id: string): ProofSummaryRow | null {
  return checks?.find((c) => c.check_id === id) ?? null;
}

/**
 * The affordance a number may wear. Only a check that actually ran, today, and
 * agreed earns a tick; everything else says so plainly.
 */
export function verifiedNote(check: ProofSummaryRow | null): {
  tone: "verified" | "warn" | "absent";
  text: string;
} {
  if (!check || check.status === "never_run") {
    return { tone: "absent", text: "not independently checked yet" };
  }
  if (check.status === "stale") {
    return { tone: "warn", text: `check last ran ${proofAge(check.hours_since)}` };
  }
  if (check.status === "diverged") {
    return {
      tone: "warn",
      text: `${check.diverged} of ${check.days_checked} day${check.days_checked === 1 ? "" : "s"} disagree`,
    };
  }
  if (check.status === "unverified") {
    return { tone: "absent", text: "no days available to check" };
  }
  return {
    tone: "verified",
    text: `verified against ${check.witness_source ?? "a second source"}`,
  };
}

export function proofAge(hours: number | string | null | undefined): string {
  if (hours === null || hours === undefined) return "never";
  const n = Number(hours);
  if (!Number.isFinite(n)) return "never";
  if (n < 1) return "under an hour ago";
  if (n < 24) return `${Math.round(n)}h ago`;
  const d = Math.round(n / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function proofWhen(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}
