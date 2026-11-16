import { activeDimensions, agencyCoverageBlocked, useFilterScope } from "@/components/FilterScope";
import {
  contractFor,
  FILTER_LABEL,
  FILTER_REASON,
  needsAgencyCoverage,
  supportsFilter,
} from "@/lib/contracts";
import type { Metric } from "@/lib/metric";
import { formatDecimal, formatINR, formatInt, formatPercent, formatRatio } from "@/lib/format";

export type MetricFormat = "inr" | "int" | "percent" | "ratio" | "decimal";

export function renderMetric(value: number, format: MetricFormat) {
  if (format === "inr") return formatINR(value);
  if (format === "percent") return formatPercent(value);
  if (format === "ratio") return formatRatio(value);
  if (format === "decimal") return formatDecimal(value);
  return formatInt(value);
}

const render = renderMetric;

/**
 * The only component allowed to put a metric on screen.
 *
 * - measured   → the number, plainly
 * - partial    → the number with a caret, titled with what is missing
 * - modelled   → the number with a MODELLED badge; it is an assumption
 * - suspect    → the number struck through; the source contradicts itself
 * - unmeasured → an em dash, never a zero
 */
export function MetricValue({
  metric,
  format = "int",
  className = "",
  emphasis = false,
  contract,
}: {
  metric: Metric;
  format?: MetricFormat;
  className?: string;
  emphasis?: boolean;
  /** Recorded definition id. Given one, the filter gate applies. */
  contract?: string | undefined;
}) {
  const scope = useFilterScope();
  const c = contractFor(contract);
  if (c) {
    const blocked = activeDimensions(scope).find((d) => !supportsFilter(c, d));
    if (!blocked && agencyCoverageBlocked(scope, needsAgencyCoverage(c))) {
      const reason = "not measurable for this team yet — its own spend is not fully traceable";
      return (
        <span
          className={`text-muted-foreground ${className}`}
          title={`${c.label}: ${reason}.`}
          aria-label={reason}
        >
          <span aria-hidden>—</span>
          <span className="ml-1.5 align-middle text-[11px] font-normal normal-case">{reason}</span>
        </span>
      );
    }
    if (blocked) {
      const reason =
        blocked === "agency"
          ? FILTER_REASON.agency
          : `${FILTER_REASON[blocked]} — its inputs do not share that key`;
      return (
        <span
          className={`text-muted-foreground ${className}`}
          title={`${c.label}: ${reason}. Splitting it by ${FILTER_LABEL[blocked]} would divide one universe by another.`}
          aria-label={reason}
        >
          <span aria-hidden>—</span>
          <span className="ml-1.5 align-middle text-[11px] font-normal normal-case">{reason}</span>
        </span>
      );
    }
  }

  if (metric.value === null || metric.state === "unmeasured") {
    return (
      <span
        className={`text-muted-foreground ${className}`}
        title={metric.note ?? "not measured — the source reported no value"}
        aria-label="not measured"
      >
        —
      </span>
    );
  }

  const text = render(metric.value, format);
  const weight = emphasis ? "font-semibold" : "";

  if (metric.state === "suspect") {
    return (
      <span
        className={`text-destructive line-through decoration-destructive/70 ${weight} ${className}`}
        title={metric.note ?? "suspect — the source disagrees with itself"}
        aria-label="suspect value"
      >
        {text}
        <span className="ml-1 align-super text-[9px] font-semibold uppercase no-underline">
          suspect
        </span>
      </span>
    );
  }

  if (metric.state === "modelled") {
    return (
      <span
        className={`text-foreground ${weight} ${className}`}
        title={metric.note ?? "modelled — computed from assumptions, not observed"}
      >
        {text}
        <span className="bg-warning/15 text-warning ml-1.5 rounded px-1 py-0.5 align-middle text-[9px] font-semibold uppercase tracking-wider">
          modelled
        </span>
      </span>
    );
  }

  if (metric.state === "partial") {
    return (
      <span
        className={`text-foreground ${weight} ${className}`}
        title={metric.note ?? "partial — some inputs are unmeasured"}
      >
        {text}
        <span className="text-warning ml-0.5 align-super text-[9px] font-semibold">◦</span>
      </span>
    );
  }

  return <span className={`${weight} ${className}`}>{text}</span>;
}

export function StateNote({ metric }: { metric: Metric }) {
  if (metric.state === "measured" || !metric.note) return null;
  return <span className="text-[11px] text-muted-foreground">{metric.note}</span>;
}
