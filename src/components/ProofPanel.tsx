import { useDensityMode } from "@/components/DensityProvider";
import { useQuery } from "@tanstack/react-query";
import { UiError } from "@/components/UiError";
import { AlertTriangle, Check, CircleSlash, Clock, Wrench } from "lucide-react";

import { formatINRPrecise, formatInt, NO_DATA, toNumber } from "@/lib/format";
import {
  PROOF_LABEL,
  proofQuery,
  proofWhen,
  type ProofHistoryCell,
  type ProofStatus,
  type ProofSummaryRow,
} from "@/lib/proof";
import { proofSeverity, TIER_CHIP } from "@/lib/severity";

const ICON: Record<ProofStatus, typeof Check> = {
  match: Check,
  diverged: AlertTriangle,
  stale: Clock,
  unverified: CircleSlash,
  never_run: CircleSlash,
  recalibrating: Wrench,
};

/** Money checks print rupees; count checks print counts. */
function figure(checkId: string, value: number | string | null): string {
  const n = toNumber(value);
  if (n === null) return NO_DATA;
  return checkId === "meta_spend" ? formatINRPrecise(n) : formatInt(n);
}

/**
 * Registrations compares two counts that are structurally different sizes, so
 * it is read as consistency, never as a match.
 */
function verdictLabel(checkId: string, verdict: string): string {
  if (checkId === "registrations") {
    if (verdict === "match" || verdict === "tolerable") return "consistent";
    if (verdict === "diverged") return "inconsistent";
  }
  return verdict.replace("_", " ");
}

function divergenceLabel(value: number | string | null): string {
  const n = toNumber(value);
  if (n === null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n}%`;
}

/** grey agrees · amber tolerable · red disagrees · faint nothing to check. */
const CELL_TONE: Record<string, string> = {
  match: "text-muted-foreground/70",
  tolerable: "text-warning",
  diverged: "text-destructive",
  witness_unavailable: "text-muted-foreground/25",
};

function HistoryStrip({ cells }: { cells: ProofHistoryCell[] }) {
  if (cells.length === 0) {
    return <span className="text-[11px] text-muted-foreground">no history yet</span>;
  }
  return (
    <span className="nums flex gap-[2px] text-[11px] leading-none">
      {cells.map((c) => (
        <span
          key={c.for_date}
          className={CELL_TONE[c.verdict] ?? "text-muted-foreground/25"}
          title={`${c.for_date} — ${c.verdict === "match" ? "agreed" : c.verdict === "diverged" ? "disagreed" : c.verdict === "tolerable" ? "within tolerance" : "nothing to check"}`}
        >
          {c.verdict === "witness_unavailable" ? "\u00b7" : "\u25a0"}
        </span>
      ))}
    </span>
  );
}

function Row({ check, history }: { check: ProofSummaryRow; history: ProofHistoryCell[] }) {
  const Icon = ICON[check.status];
  const worstDivergent = check.diverged > 0;
  const tier = proofSeverity(check);
  return (
    <tr className="border-border/60 border-t align-top">
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${TIER_CHIP[tier]}`}
          >
            <Icon className="h-3 w-3" aria-hidden />
            {PROOF_LABEL[check.status]}
          </span>
          <span className="text-sm font-medium">{check.label}</span>
        </div>
        <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-muted-foreground">
          {check.plain}
        </p>
        {check.needs_recalibration ? (
          <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-warning">
            Watching, not broken: {check.diverged_30d} disagreements in 30 days against a budget of{" "}
            {String(check.fp_budget_per_30d)}. It keeps recording and is left out of the headline
            count until someone resolves it in the queue.
          </p>
        ) : null}
        {check.structural_note ? (
          <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-muted-foreground/80">
            Known and expected: {check.structural_note}
          </p>
        ) : null}
        <div className="mt-1.5">
          <HistoryStrip cells={history} />
        </div>
      </td>

      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
        {proofWhen(check.last_run)}
      </td>
      <td className="px-3 py-2 text-right text-sm tabular-nums">{check.days_checked || "—"}</td>
      <td className="px-3 py-2 text-right text-sm tabular-nums text-positive">
        {check.matches + check.tolerable || "—"}
      </td>
      <td
        className={`px-3 py-2 text-right text-sm tabular-nums ${check.diverged > 0 ? "text-destructive" : "text-muted-foreground"}`}
      >
        {check.diverged || "—"}
      </td>
      <td className="px-3 py-2 text-xs">
        {check.worst_date && (worstDivergent || toNumber(check.worst_divergence) !== 0) ? (
          <div className="space-y-0.5">
            <div className="tabular-nums">
              {check.worst_date} · {divergenceLabel(check.worst_divergence)}
            </div>
            <div className="text-muted-foreground tabular-nums">
              {figure(check.check_id, check.worst_primary)} vs{" "}
              {figure(check.check_id, check.worst_witness)}
            </div>
          </div>
        ) : (
          <span className="text-muted-foreground">no gap</span>
        )}
      </td>
    </tr>
  );
}

/**
 * The proof section that opens /trust.
 *
 * It leads with the claim, then evidences it. Where a number has no
 * independent witness — hand-entered collections — the panel says so rather
 * than letting silence read as verification.
 */
export function ProofPanel() {
  const { data } = useQuery(proofQuery(14));
  const { density } = useDensityMode();
  const checks = data?.checks ?? [];
  const detail = data?.detail ?? [];

  return (
    <section id="proof" className="border-border bg-card rounded-md border">
      <div className="border-border border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Proof</h2>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Every number below is checked daily against a second source that cannot share its
          mistakes. The checks run after the syncs, re-examine the last seven days each time because
          sources backfill, and record what they found — including when they could not look.
        </p>
      </div>

      {data?.error ? (
        <UiError
          detail={data.error}
          subject="the checks"
          where="proof panel"
          className="px-4 py-3"
        />
      ) : checks.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">{NO_DATA}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Check</th>
                <th className="px-3 py-2 font-medium">Last run</th>
                <th className="px-3 py-2 text-right font-medium">Days</th>
                <th className="px-3 py-2 text-right font-medium">Agree</th>
                <th className="px-3 py-2 text-right font-medium">Disagree</th>
                <th className="px-3 py-2 font-medium">Worst gap</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <Row
                  key={c.check_id}
                  check={c}
                  history={(data?.history ?? []).filter((h) => h.check_id === c.check_id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="border-border border-t px-4 py-3 text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">What we cannot prove.</span> Collections
        entered by hand have no second source; this engine checks their internal consistency (closed
        months, the settling rule) but cannot independently verify them. No number on this screen
        claims otherwise.
      </p>

      {density === "working" && detail.length > 0 ? (
        <details className="border-border border-t px-4 py-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Every row, every day ({detail.length})
          </summary>
          <div className="mt-3 max-h-96 overflow-auto">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 font-medium">Check</th>
                    <th className="px-2 py-1 font-medium">Day</th>
                    <th className="px-2 py-1 text-right font-medium">Ours</th>
                    <th className="px-2 py-1 text-right font-medium">Witness</th>
                    <th className="px-2 py-1 text-right font-medium">Gap</th>
                    <th className="px-2 py-1 font-medium">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.map((r) => (
                    <tr key={`${r.check_id}-${r.for_date}`} className="border-border/60 border-t">
                      <td className="px-3 py-1">{r.check_id}</td>
                      <td className="px-3 py-1 tabular-nums">{r.for_date}</td>
                      <td className="px-3 py-1 text-right tabular-nums">
                        {figure(r.check_id, r.primary_value)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">
                        {figure(r.check_id, r.witness_value)}
                      </td>
                      <td className="px-3 py-1 text-right tabular-nums">
                        {divergenceLabel(r.divergence_pct)}
                      </td>
                      <td
                        className={`px-2 py-1 ${r.verdict === "diverged" ? "text-destructive" : r.verdict === "match" ? "text-positive" : "text-muted-foreground"}`}
                      >
                        {verdictLabel(r.check_id, r.verdict)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      ) : null}
    </section>
  );
}
