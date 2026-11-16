import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { arbitrate, ruleFor } from "@/lib/arbitration";
import { proofOf, proofQuery } from "@/lib/proof";

/**
 * The provenance mark a number wears.
 *
 * Deliberately almost invisible when the sources agree — that is the ordinary
 * state and a screen of loud ticks is noise. Only a disagreement takes colour
 * and becomes a link. 10px, no badge, no box.
 */
export function Provenance({ metric, className = "" }: { metric: string; className?: string }) {
  const rule = ruleFor(metric);
  const { data } = useQuery(proofQuery(14));
  if (!rule) return null;

  const arb = arbitrate(rule, rule.checkId ? proofOf(data?.checks, rule.checkId) : null);

  if (arb.state === "disagree") {
    return (
      <Link
        to="/trust"
        search={{ range: "last30" as const, compare: false }}
        hash="proof"
        title={arb.detail}
        aria-label={`Sources disagree. ${arb.detail}`}
        className={`text-warning inline-flex items-center gap-1 align-middle text-[10px] leading-none hover:underline ${className}`}
      >
        <span aria-hidden>◆</span>
        <span>sources disagree</span>
      </Link>
    );
  }

  const glyph = arb.state === "agree" ? "✓✓" : "✓";
  const label = arb.state === "agree" ? "two sources agree" : "one source";

  return (
    <span
      title={arb.detail}
      aria-label={`${label}. ${arb.detail}`}
      className={`text-muted-foreground/40 inline-flex select-none items-center align-middle text-[10px] leading-none ${className}`}
    >
      <span aria-hidden>{glyph}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
