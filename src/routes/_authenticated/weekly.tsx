import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { UiError, RouteError } from "@/components/UiError";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { AppShell } from "@/components/AppShell";
import { EngineUnreadable } from "@/components/DataOutage";
import { Kpi } from "@/components/Kpi";
import { MetricValue } from "@/components/MetricValue";
import { Button } from "@/components/ui/button";
import { accountView, totals as computeTotals } from "@/lib/account-view";
import { getBrief } from "@/lib/analyst.functions";
import { getOverview } from "@/lib/dashboard.functions";
import { formatINR, formatInt, formatPercent, NO_DATA } from "@/lib/format";
import { fromNullable, measured, rate, sumMetrics, unmeasured, type Metric } from "@/lib/metric";
import { getProof } from "@/lib/proof.functions";
import { getWebinars } from "@/lib/zoom.functions";

/** Monday of the last complete Mon–Sun week, in IST. */
function lastCompleteWeek(): { since: string; until: string } {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const dow = (nowIst.getUTCDay() + 6) % 7; // 0 = Monday
  const thisMonday = new Date(nowIst);
  thisMonday.setUTCDate(nowIst.getUTCDate() - dow);
  const lastMonday = new Date(thisMonday);
  lastMonday.setUTCDate(thisMonday.getUTCDate() - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setUTCDate(lastMonday.getUTCDate() + 6);
  return {
    since: lastMonday.toISOString().slice(0, 10),
    until: lastSunday.toISOString().slice(0, 10),
  };
}

function shiftWeek(since: string, weeks: number) {
  const d = new Date(`${since}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + weeks * 7);
  const s = d.toISOString().slice(0, 10);
  const e = new Date(d);
  e.setUTCDate(d.getUTCDate() + 6);
  return { since: s, until: e.toISOString().slice(0, 10) };
}

type WeeklySearch = { week?: string };

const weekQuery = (since: string, until: string) =>
  queryOptions({
    queryKey: ["weekly-overview", since, until],
    queryFn: () => getOverview({ data: { since, until } }),
  });

export const Route = createFileRoute("/_authenticated/weekly")({
  validateSearch: (search: Record<string, unknown>): WeeklySearch =>
    typeof search["week"] === "string" ? { week: search["week"] as string } : {},
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    const w = deps.week ? shiftWeek(deps.week, 0) : lastCompleteWeek();
    return context.queryClient.ensureQueryData(weekQuery(w.since, w.until));
  },
  head: () => ({
    meta: [
      { title: "Weekly Review — EQH Performance Engine" },
      {
        name: "description",
        content:
          "One complete Monday-to-Sunday week composed from figures already checked elsewhere: spend, registrations, cost per registration, sales, cash, show-up, the verdict and the week's proof state.",
      },
      { property: "og:title", content: "Weekly Review — EQH Performance Engine" },
      {
        property: "og:description",
        content: "The week in one printable page, with no new arithmetic anywhere on it.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: WeeklyPage,
    errorComponent: ({ error, reset }) => (
    <RouteError error={error} reset={reset} subject="the weekly view" where="src/routes/weekly.tsx" />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

function delta(now: Metric, prior: Metric) {
  if (now.value === null || prior.value === null || prior.value === 0) return null;
  return ((now.value - prior.value) / prior.value) * 100;
}

function DeltaText({ now, prior }: { now: Metric; prior: Metric }) {
  const d = delta(now, prior);
  if (d === null) return <span className="text-muted-foreground">no comparison</span>;
  return (
    <span className="tabular-nums text-muted-foreground">
      {d >= 0 ? "+" : ""}
      {formatPercent(d)} on the week before
    </span>
  );
}

/** Strips markdown marks so the owner never sees ## or ** on screen. */
function plainLines(md: string): { text: string; heading: boolean }[] {
  return md
    .split("\n")
    .map((raw) => raw.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      const heading = l.startsWith("#");
      const text = l
        .replace(/^#+\s*/, "")
        .replace(/^[-*]\s+/, "\u2022 ")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/`/g, "")
        .replace(/_/g, " ");
      return { text, heading };
    });
}

function WeeklyPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const week = search.week ? shiftWeek(search.week, 0) : lastCompleteWeek();

  const { data: overview } = useSuspenseQuery(weekQuery(week.since, week.until));
  // The week in progress is never shown: half a week against a whole one is a
  // fake decline every Monday.
  const atLatestWeek = week.since >= lastCompleteWeek().since;
  const priorWeek = shiftWeek(week.since, -1);
  const prior = useQuery(weekQuery(priorWeek.since, priorWeek.until));
  const webinars = useQuery({
    queryKey: ["weekly-webinars", week.since, week.until],
    queryFn: () => getWebinars({ data: { since: week.since, until: week.until } }),
  });
  const brief = useQuery({ queryKey: ["weekly-brief"], queryFn: () => getBrief() });
  const proof = useQuery({
    queryKey: ["weekly-proof", week.since, week.until],
    queryFn: () => getProof({ data: { days: 14 } }),
  });

  const rangeDays = 7;
  const t = useMemo(
    () => computeTotals(overview.accounts.map((row) => accountView(row, { rangeDays }))),
    [overview.accounts],
  );
  const priorT = useMemo(
    () => computeTotals((prior.data?.accounts ?? []).map((row) => accountView(row, { rangeDays }))),
    [prior.data],
  );

  const collected: Metric = overview.frontEnd
    ? measured(overview.frontEnd.collected)
    : unmeasured("no ledger collections for this week");
  const priorCollected: Metric = prior.data?.frontEnd
    ? measured(prior.data.frontEnd.collected)
    : unmeasured("prior week not read");
  const sales: Metric = overview.frontEnd
    ? measured(overview.frontEnd.sales)
    : unmeasured("no ledger sales for this week");
  const priorSales: Metric = prior.data?.frontEnd
    ? measured(prior.data.frontEnd.sales)
    : unmeasured("prior week not read");

  const webinarsFailed = webinars.isError;
  const events = webinarsFailed ? [] : (webinars.data?.events ?? []);
  const withRegistrants = events.filter((e) => e.registrants !== null);
  const attendeesMatched = sumMetrics(
    withRegistrants.map((e) => fromNullable(e.attendees_matched)),
  );
  const registrants = sumMetrics(withRegistrants.map((e) => fromNullable(e.registrants)));
  const showUp = rate(attendeesMatched, registrants);
  const attendees = sumMetrics(events.map((e) => fromNullable(e.attendees)));
  const at60 = sumMetrics(events.map((e) => fromNullable(e.at_60)));
  const retention60 = rate(at60, attendees, { min: 10 });

  const scaling = useMemo(() => {
    const md = brief.data?.brief ?? "";
    if (!md) return null;
    const idx = md.toUpperCase().indexOf("SCALING WATCH");
    if (idx < 0) return null;
    const rest = md.slice(idx);
    const next = rest.indexOf("\n## ", 3);
    return next > 0 ? rest.slice(0, next).trim() : rest.trim();
  }, [brief.data]);

  const proofRows = (proof.data?.detail ?? []).filter(
    (r) => r.for_date >= week.since && r.for_date <= week.until,
  );
  const proofAgree = proofRows.filter(
    (r) => r.verdict === "match" || r.verdict === "tolerable",
  ).length;
  const proofOff = proofRows.filter((r) => r.verdict === "diverged").length;

  return (
    <AppShell
      topBar={
        <div className="flex flex-wrap items-center gap-2 px-4 py-2">
          <h1 className="text-sm font-semibold tracking-tight">Weekly review</h1>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {week.since} → {week.until}
          </span>
          <div className="ml-auto flex items-center gap-1.5 print:hidden">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigate({ search: { week: shiftWeek(week.since, -1).since } })}
            >
              Previous week
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={atLatestWeek}
              title={
                atLatestWeek
                  ? "This is the most recent finished week. The week in progress is not shown, because a part-week cannot be compared with a whole one."
                  : undefined
              }
              onClick={() => void navigate({ search: { week: shiftWeek(week.since, 1).since } })}
            >
              Next week
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.print()}>
              Print
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5 px-6 py-4">
        {overview.error ? <EngineUnreadable detail={overview.error} /> : null}
        {overview.error ? null : (
          <p className="max-w-3xl text-[13px] leading-relaxed">
            In the week of <span className="font-medium">{week.since}</span> to{" "}
            <span className="font-medium">{week.until}</span>, spend was{" "}
            <span className="font-medium tabular-nums">
              {t.spend.value === null ? NO_DATA : formatINR(t.spend.value)}
            </span>{" "}
            against{" "}
            <span className="font-medium tabular-nums">
              {t.measuredLeads.value === null ? NO_DATA : formatInt(t.measuredLeads.value)}
            </span>{" "}
            registrations on accounts whose lead tracking works, a cost per registration of{" "}
            <span className="font-medium tabular-nums">
              {t.costPerMeasuredRegistration.value === null
                ? NO_DATA
                : formatINR(t.costPerMeasuredRegistration.value)}
            </span>
            . The ledger recorded{" "}
            <span className="font-medium tabular-nums">
              {sales.value === null ? NO_DATA : formatInt(sales.value)}
            </span>{" "}
            sales and{" "}
            <span className="font-medium tabular-nums">
              {collected.value === null ? NO_DATA : formatINR(collected.value)}
            </span>{" "}
            collected. Every figure here is the one already shown on its own screen — this page
            composes, it never recalculates.
          </p>
        )}

        <section className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <Kpi variant="card" label="Spend" metric={t.spend} format="inr" contract="meta_spend" />
          <Kpi
            variant="card"
            label="Registrations (measured accounts)"
            metric={t.measuredLeads}
            format="int"
            contract="registrations"
          />
          <Kpi
            variant="card"
            label="Cost per registration"
            metric={t.costPerMeasuredRegistration}
            format="inr"
            contract="cost_per_registration"
          />
          <Kpi
            variant="card"
            label="Sales"
            metric={sales}
            format="int"
            contract="ledger_l1_new_sales"
          />
          <Kpi
            variant="card"
            label="Collected (gross)"
            metric={collected}
            format="inr"
            contract="l1_collected_all_sources"
          />
        </section>

        <section className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px] md:grid-cols-5">
          <DeltaText now={t.spend} prior={priorT.spend} />
          <DeltaText now={t.measuredLeads} prior={priorT.measuredLeads} />
          <DeltaText
            now={t.costPerMeasuredRegistration}
            prior={priorT.costPerMeasuredRegistration}
          />
          <DeltaText now={sales} prior={priorSales} />
          <DeltaText now={collected} prior={priorCollected} />
        </section>

        <section className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight">Who stayed</h2>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            <Kpi
              variant="card"
              label="Show-up"
              metric={showUp}
              format="percent"
              contract="show_up_rate"
            />
            <Kpi
              variant="card"
              label="Still there at 60 minutes"
              metric={retention60}
              format="percent"
              contract="retention_60"
            />
            <Kpi
              variant="card"
              label="Webinar days"
              metric={
                webinarsFailed
                  ? unmeasured("the webinar read did not answer")
                  : measured(events.length)
              }
              format="int"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Show-up counts attendees only on sessions that also reported a registrant count
            {withRegistrants.length === events.length
              ? ""
              : ` — ${events.length - withRegistrants.length} session-day(s) here reported none`}
            .
          </p>
        </section>

        <section className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight">Monday's scaling verdict</h2>
          {brief.isPending ? (
            <p className="text-[12px] text-muted-foreground">Reading the brief…</p>
          ) : scaling ? (
            <div className="space-y-1 rounded border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed">
              {plainLines(scaling).map((line, i) => (
                <p key={i} className={line.heading ? "font-semibold" : ""}>
                  {line.text}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              No scaling verdict was written for this week — {NO_DATA}.
            </p>
          )}
        </section>

        <section className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight">What the week's checks said</h2>
          {proof.isPending ? (
            <p className="text-[12px] text-muted-foreground">Running the week's checks…</p>
          ) : proofRows.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">
              No check could be run for this week — this is not an all-clear.
            </p>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              {formatInt(proofRows.length)} checks ran: {formatInt(proofAgree)} agreed across
              sources, {formatInt(proofOff)} did not.
            </p>
          )}
        </section>

        <p className="text-[11px] text-muted-foreground">
          Spend, registrations and cost per registration:{" "}
          <MetricValue metric={t.measuredSpend} format="inr" /> of spend sits on accounts with
          working lead tracking. Where a figure could not be measured it says so rather than showing
          a zero.
        </p>
      </div>
    </AppShell>
  );
}
