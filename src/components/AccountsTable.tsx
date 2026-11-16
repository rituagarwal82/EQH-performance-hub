import { useState } from "react";

import { MetricValue } from "@/components/MetricValue";
import {
  type AccountView,
  RETARGETING_CAPTION,
  splitRankable,
  TRACKING_LABEL,
  type Totals,
} from "@/lib/account-view";
import { compareMetric, divideMetrics, type Metric } from "@/lib/metric";
import { count } from "@/lib/counts";

type SortKey = "spend" | "leads" | "cpl" | "lpv" | "impressions" | "purchases";

const COLUMNS: { key: SortKey; label: string; format: "inr" | "int" }[] = [
  { key: "spend", label: "Spend", format: "inr" },
  { key: "impressions", label: "Impressions", format: "int" },
  { key: "lpv", label: "Landing page views", format: "int" },
  { key: "leads", label: "Registrations (all accounts)", format: "int" },
  { key: "cpl", label: "Cost per registration", format: "inr" },
  { key: "purchases", label: "Purchases", format: "int" },
];

function pick(v: AccountView, key: SortKey): Metric {
  switch (key) {
    case "spend":
      return v.spend;
    case "leads":
      return v.leads;
    case "cpl":
      return v.cpl;
    case "lpv":
      return v.landingPageViews;
    case "impressions":
      return v.impressions;
    case "purchases":
      return v.purchases;
  }
}

function TrackingBadge({ view }: { view: AccountView }) {
  // A retargeting/brand account is never judged on lead tracking: it advertises
  // to people we already have, so "no lead tracking" was an alarm about the plan.
  if (view.role === "retargeting_brand") {
    return (
      <span
        className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
        title={RETARGETING_CAPTION}
      >
        retargeting / brand
      </span>
    );
  }
  const tone =
    view.tracking === "working"
      ? "bg-positive/15 text-positive"
      : view.tracking === "broken"
        ? "bg-destructive/15 text-destructive"
        : "bg-muted text-muted-foreground";
  const short =
    view.tracking === "working"
      ? "measured"
      : view.tracking === "broken"
        ? "no lead tracking"
        : view.tracking === "not_applicable"
          ? "n/a"
          : "unverified";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone}`}
      title={TRACKING_LABEL[view.tracking]}
    >
      {short}
    </span>
  );
}

export function AccountsTable({
  views,
  totals,
  compact = false,
}: {
  views: AccountView[];
  totals: Totals;
  compact?: boolean;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "spend",
    dir: "desc",
  });

  const columns = compact
    ? COLUMNS.filter((c) => c.key !== "purchases" && c.key !== "impressions")
    : COLUMNS;

  // Retargeting / brand accounts sit in their own group: they are not supposed
  // to create new leads, so they must not be read against the lead-gen ones.
  const leadGen = views.filter((v) => v.role !== "retargeting_brand");
  const retargeting = views
    .filter((v) => v.role === "retargeting_brand")
    .sort((a, b) => compareMetric(a.spend, b.spend, "desc"));

  // Unmeasured values never sort as if they were zero. They land in a terminal
  // group under a divider, so "best performers" cannot be four broken pixels.
  const { rankable, unrankable } = splitRankable(leadGen, (v) => pick(v, sort.key));
  rankable.sort((a, b) => compareMetric(pick(a, sort.key), pick(b, sort.key), sort.dir));

  const header = (key: SortKey, label: string) => (
    <th key={key} className="text-right">
      <button
        onClick={() =>
          setSort((s) =>
            s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" },
          )
        }
        className="hover:text-foreground"
      >
        {label}
        {sort.key === key ? <span className="ml-1">{sort.dir === "asc" ? "↑" : "↓"}</span> : null}
      </button>
    </th>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
            <th className="text-left">Account</th>
            <th className="text-left">Agency</th>
            <th className="text-left">Lead tracking</th>
            {columns.map((c) => header(c.key, c.label))}
            <th className="text-right">Share of spend</th>
          </tr>
        </thead>
        <tbody>
          {rankable.map((v) => (
            <Row key={v.row.account_id} view={v} totals={totals} columns={columns} />
          ))}

          {unrankable.length > 0 ? (
            <>
              <tr>
                <td
                  colSpan={columns.length + 4}
                  className="border-border bg-muted/40 border-y px-4 py-1.5 text-center text-[11px] uppercase tracking-wider text-muted-foreground"
                >
                  — {count(unrankable.length)} account
                  {unrankable.length === 1 ? "" : "s"} cannot be ranked —
                </td>
              </tr>
              {unrankable
                .slice()
                .sort((a, b) => compareMetric(a.spend, b.spend, "desc"))
                .map((v) => (
                  <Row key={v.row.account_id} view={v} totals={totals} columns={columns} />
                ))}
            </>
          ) : null}

          {retargeting.length > 0 ? (
            <>
              <tr>
                <td
                  colSpan={columns.length + 4}
                  className="border-border bg-muted/40 border-y px-4 py-1.5 text-center text-[11px] uppercase tracking-wider text-muted-foreground"
                >
                  — {count(retargeting.length)} account
                  {retargeting.length === 1 ? "" : "s"}: {RETARGETING_CAPTION} —
                </td>
              </tr>
              {retargeting.map((v) => (
                <Row key={v.row.account_id} view={v} totals={totals} columns={columns} />
              ))}
            </>
          ) : null}
        </tbody>
      </table>
      <MeasuredCountsLine totals={totals} />
    </div>
  );
}

/**
 * The registrations column sums EVERY account, including unverified trackers,
 * while every KPI counts only measured accounts. Without this line the two
 * numbers sit inches apart and read as a contradiction.
 */
function MeasuredCountsLine({ totals }: { totals: Totals }) {
  const measured = totals.measuredLeads.value;
  const all = totals.leads.value;
  if (measured === null || all === null) return null;
  return (
    <p className="border-border border-t px-3 py-2 text-[11px] text-muted-foreground">
      {count(measured)} of {count(all)} registrations in this column are on accounts with working
      lead tracking. Every registration figure and cost-per-registration elsewhere counts only
      those {count(measured)}.
    </p>
  );
}

function Row({
  view,
  totals,
  columns,
}: {
  view: AccountView;
  totals: Totals;
  columns: { key: SortKey; label: string; format: "inr" | "int" }[];
}) {
  const share = divideMetrics(view.spend, totals.spend);
  const sharePct = share.value === null ? share : { ...share, value: share.value * 100 };

  return (
    <tr className="border-border hover:bg-muted/50 border-b last:border-b-0 [&>td]:px-3 [&>td]:py-1.5">
      <td className="font-medium">
        {view.row.name}
        {!view.row.is_active ? (
          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
            ended
          </span>
        ) : null}
      </td>
      <td className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {view.row.agency_code ?? "—"}
      </td>
      <td>
        <TrackingBadge view={view} />
      </td>
      {columns.map((c) => (
        <td key={c.key} className="nums text-right">
          <MetricValue metric={pick(view, c.key)} format={c.format} emphasis={c.key === "spend"} />
        </td>
      ))}
      <td className="nums text-right text-muted-foreground">
        <MetricValue metric={sharePct} format="percent" />
      </td>
    </tr>
  );
}
