import { activeDimensions, agencyCoverageBlocked, useFilterScope } from "@/components/FilterScope";
import { MetricValue, type MetricFormat } from "@/components/MetricValue";
import { Provenance } from "@/components/Provenance";
import { NO_DATA } from "@/lib/format";
import { contractFor, contractTitle, needsAgencyCoverage, supportsFilter } from "@/lib/contracts";
import { divideMetrics, type Metric } from "@/lib/metric";

/**
 * THE tile. One component for every headline figure on every screen, so a
 * number cannot get a softer gate by being posted on a quieter page: the
 * contract mark, the filter refusal, the provenance mark and the delta rules
 * are decided here once.
 */
export function Kpi({
  label,
  metric,
  value,
  format = "int",
  hint,
  prior,
  suppressDelta = false,
  suppressReason,
  provenance,
  contract,
  note,
  footer,
  tone,
  variant = "grid",
}: {
  label: string;
  metric?: Metric | undefined;
  /** A pre-formatted count, for tiles whose figure is not a Metric. */
  value?: string | undefined;
  format?: MetricFormat;
  hint?: string | undefined;
  prior?: Metric | undefined;
  suppressDelta?: boolean;
  suppressReason?: string | undefined;
  provenance?: string | undefined;
  /** Recorded definition id. Money and ratios without one are not posted. */
  contract?: string | undefined;
  /** One-line honesty note under the tile (e.g. I-SYM excluded cash). */
  note?: string | undefined;
  /** Extra line under the tile — a hint at depth, never a second figure. */
  footer?: React.ReactNode;
  tone?: "amber" | "primary" | undefined;
  /** grid = a cell in a bordered KPI row; card = a standalone bordered tile. */
  variant?: "grid" | "card";
}) {
  const scope = useFilterScope();

  // A delta between two windows of different length is not a delta.
  const deltaMetric =
    !suppressDelta &&
    prior &&
    metric &&
    prior.value !== null &&
    metric.value !== null &&
    prior.value !== 0
      ? divideMetrics(
          { ...metric, value: Number(metric.value) - prior.value },
          { ...prior, value: Math.abs(prior.value) },
        )
      : null;
  const delta = deltaMetric?.value === null ? null : (deltaMetric?.value ?? null);
  const trustworthy = deltaMetric ? deltaMetric.state === "measured" : false;

  // The render gate. A rupee figure or a ratio is only posted when its meaning
  // is written down somewhere a human signed off on. A tile that names a
  // definition the registry does not hold is refused outright — showing the
  // number would assert a meaning that does not exist.
  const contractId = contract ?? provenance;
  const found = contractFor(contractId);
  const filterBlocked =
    found !== null &&
    (activeDimensions(scope).some((d) => !supportsFilter(found, d)) ||
      agencyCoverageBlocked(scope, needsAgencyCoverage(found)));
  const needsContract = format === "inr" || format === "ratio";
  const refused = needsContract && contractId !== undefined && found === null;
  const uncontracted = needsContract && contractId === undefined;

  const shell =
    variant === "card"
      ? `rounded border px-3 py-2 ${
          tone === "amber"
            ? "border-amber-500/50 bg-amber-500/5"
            : tone === "primary"
              ? "border-primary/50 bg-primary/5"
              : "border-border"
        }`
      : "border-border border-r px-5 py-4 last:border-r-0";

  return (
    <div className={shell}>
      <div
        className={
          variant === "card"
            ? "text-[10px] uppercase tracking-wide text-muted-foreground"
            : "text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
        }
      >
        {label}
      </div>
      <div
        className={
          variant === "card"
            ? "mt-0.5 flex items-baseline gap-1.5 font-mono text-lg tabular-nums"
            : "nums mt-1.5 flex items-baseline gap-1.5 text-2xl"
        }
      >
        {refused ? (
          <span
            className="text-warning text-base font-medium"
            title={`This figure claims the definition "${contractId}", which is not in the definition register. Until the definition is recorded, the number is not shown.`}
          >
            definition missing
          </span>
        ) : metric ? (
          <MetricValue metric={metric} format={format} emphasis contract={contractId} />
        ) : (
          <span
            className={
              value === undefined || value === NO_DATA
                ? "text-muted-foreground/70 text-base font-normal italic"
                : "font-semibold"
            }
          >
            {value ?? NO_DATA}
          </span>
        )}
        {found ? (
          <span
            className="text-muted-foreground/40 select-none align-middle text-[10px] leading-none"
            title={contractTitle(found)}
          >
            §
          </span>
        ) : uncontracted ? (
          <span
            className="text-warning/70 select-none align-middle text-[10px] leading-none"
            title="No recorded definition for this figure — read it as a working number, not a signed-off one."
          >
            §?
          </span>
        ) : null}
        {/* A provenance mark is a verdict about a number. With no number there
            is nothing for two sources to agree or disagree about, so the mark
            is suppressed rather than left floating beside an em-dash. */}
        {provenance && metric?.value != null && !filterBlocked ? <Provenance metric={provenance} /> : null}
      </div>

      <div className="mt-0.5 flex flex-wrap items-baseline gap-2 text-[11px] text-muted-foreground">
        {filterBlocked ? (
          <span>counts for this team are shown in the team section — ratios are not</span>
        ) : hint ? (
          <span>{hint}</span>
        ) : null}
        {suppressDelta && prior ? (
          <span className="text-warning" title={suppressReason}>
            comparison suppressed
          </span>
        ) : filterBlocked ? null : delta !== null && deltaMetric ? (
          <span
            className={
              !trustworthy
                ? "text-muted-foreground"
                : delta >= 0
                  ? "text-positive"
                  : "text-destructive"
            }
            title={deltaMetric.note ?? undefined}
          >
            <MetricValue
              metric={{
                ...deltaMetric,
                value: delta * 100,
              }}
              format="percent"
            />{" "}
            vs prior window of equal length
          </span>
        ) : prior ? (
          <span>no comparable prior period</span>
        ) : null}
      </div>
      {note && !filterBlocked ? (
        <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{note}</div>
      ) : null}
      {footer && !filterBlocked ? <div className="mt-1 text-[11px]">{footer}</div> : null}
    </div>
  );
}
