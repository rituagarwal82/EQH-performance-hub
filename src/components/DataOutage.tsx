import { AlertTriangle, HelpCircle } from "lucide-react";

import { humanError, useTechnicalDetail } from "@/lib/error-copy";

/**
 * Degradation states.
 *
 * House rule, owner-set after the 6 Sep database outage: green means VERIFIED
 * HEALTHY. The absence of data is never green. A surface whose query failed,
 * or which had nothing it could actually check, says so in amber — it never
 * falls through to an all-clear, and it never prints prose about a day it
 * could not resolve.
 *
 * Second house rule, 7 Sep: no raw database or driver text ever reaches this
 * screen. The verbatim detail goes to the console and to Feed Health.
 */

/** The engine cannot read its data at all. One banner, no pseudo-figures. */
export function EngineUnreadable({ detail }: { detail?: string | null }) {
  useTechnicalDetail("overview query failed", detail);
  return (
    <section
      role="alert"
      className="border-destructive/40 bg-destructive/10 mb-5 rounded-md border px-4 py-3"
    >
      <div className="flex items-center gap-2 text-[13px] font-semibold text-destructive">
        <AlertTriangle className="size-4" />
        {humanError(detail, "the figures")}
      </div>
      <p className="mt-1 break-words text-[12px] leading-relaxed text-muted-foreground">
        Stored data is untouched. Sections that depend on this reading are held back rather than
        shown as zero; reload in a minute, or open Feed Health for the technical detail.
      </p>
    </section>
  );
}

/** Checks exist but none could run. Amber — explicitly not an all-clear. */
export function ChecksCouldNotRun({ reason, detail }: { reason: string; detail?: string | null }) {
  useTechnicalDetail("checks could not run", detail);
  return (
    <section
      role="alert"
      className="border-warning/40 bg-warning/10 mt-5 rounded-md border px-4 py-3"
    >
      <div className="flex items-center gap-2 text-[13px] font-semibold text-warning">
        <HelpCircle className="size-4" />
        Checks could not run — {reason}.
      </div>
      <p className="mt-1 break-words text-[12px] leading-relaxed text-muted-foreground">
        This is not an all-clear. Zero measures were tested, so nothing about today has been
        verified either way.
      </p>
    </section>
  );
}

/**
 * One section could not load. Used in place of a section's contents, so a
 * failed query never renders a zero, a "0 of 0", or a "no data" that reads as
 * a measured emptiness.
 */
export function SectionUnavailable({
  title,
  detail,
  className = "",
}: {
  title: string;
  detail?: string | null;
  className?: string;
}) {
  useTechnicalDetail(`${title} section failed`, detail);
  return (
    <section
      className={`border-border bg-muted/30 rounded-md border border-dashed px-4 py-5 ${className}`}
    >
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <p className="mt-1 text-[12px] text-muted-foreground">
        This section could not load. It is not empty and it is not zero — it simply has not been
        read yet.
      </p>
    </section>
  );
}
