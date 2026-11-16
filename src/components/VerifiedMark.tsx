import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, HelpCircle } from "lucide-react";

import { proofOf, proofQuery, verifiedNote, type ProofSummaryRow } from "@/lib/proof";

/**
 * The affordance a headline number wears.
 *
 * A tick appears only when that number's own check ran and agreed. A check that
 * did not run renders as absence, never as a pass — otherwise the mark would be
 * the very kind of unearned reassurance this layer exists to abolish.
 */
export function VerifiedMark({
  check,
  label,
  className = "",
}: {
  check: ProofSummaryRow | null;
  label?: string;
  className?: string;
}) {
  const note = verifiedNote(check);
  const text = label ?? note.text;

  const tone =
    note.tone === "verified"
      ? "text-positive"
      : note.tone === "warn"
        ? "text-destructive"
        : "text-muted-foreground";

  const Icon = note.tone === "verified" ? Check : note.tone === "warn" ? AlertTriangle : HelpCircle;

  return (
    <Link
      to="/trust"
      search={{ range: "last30" as const, compare: false }}
      hash="proof"
      title={
        check
          ? `${check.label}: ${check.plain} Last run ${check.last_run ?? "never"}.`
          : "This number has no independent check yet."
      }
      className={`inline-flex items-center gap-1 text-[11px] ${tone} hover:underline ${className}`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      <span>{text}</span>
    </Link>
  );
}

/**
 * The affordance line under a headline or the daily sentence: one mark per
 * check that stands behind those numbers.
 */
export function ProofLine({ ids, className = "" }: { ids: string[]; className?: string }) {
  const { data } = useQuery(proofQuery(14));
  if (!data?.configured) return null;
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${className}`}>
      {ids.map((id) => {
        const check = proofOf(data.checks, id);
        return <VerifiedMark key={id} check={check} />;
      })}
    </div>
  );
}
