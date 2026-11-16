import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { UiError, RouteError } from "@/components/UiError";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { Fragment, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AccountsTable } from "@/components/AccountsTable";
import { getAgencyRatioFlags } from "@/lib/agency.functions";
import { FilterScope } from "@/components/FilterScope";
import { AppShell } from "@/components/AppShell";
import { SectionUnavailable } from "@/components/DataOutage";
import { CoverageLine } from "@/components/CoverageLine";
import { ProofLine } from "@/components/VerifiedMark";
import { Figure } from "@/components/Figure";
import { MetricValue } from "@/components/MetricValue";
import { AdPerformanceTable } from "@/components/AdPerformanceTable";
import { GrainSwitch, RangeBar } from "@/components/RangeBar";
import { Kpi } from "@/components/Kpi";
import { useDensityMode } from "@/components/DensityProvider";
import {
  accountView,
  entityView,
  splitRankable,
  totals as computeTotals,
} from "@/lib/account-view";
import { getAdsMeta, getEntityDrill } from "@/lib/ads.functions";
import { count, inrText } from "@/lib/counts";
import { getEntityRollup } from "@/lib/dashboard.functions";
import { NO_DATA } from "@/lib/format";
import { bucketise, coverageLabel } from "@/lib/grain-series";
import { divideMetrics, fromNullable, fromObserved, rate, sumMetrics } from "@/lib/metric";
import { overviewQuery } from "@/lib/overview-query";
import { coverageDeltaGuard } from "@/lib/coverage-shift";
import { validateRangeSearch } from "@/lib/range-search";
import { BRIEF_ROWS, type Grain } from "@/lib/view-prefs";

const GRAINS = ["account", "campaign", "adset", "ad"] as const;
type AdGrain = (typeof GRAINS)[number];
const GRAIN_LABEL: Record<AdGrain, string> = {
  account: "Account",
  campaign: "Campaign",
  adset: "Ad set",
  ad: "Ad",
};

export const Route = createFileRoute("/_authenticated/ads")({
  validateSearch: validateRangeSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(overviewQuery(deps)),
  head: () => ({
    meta: [
      { title: "Ads — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Meta Ads spend and cost per registration for Energy Queens Hub at account, campaign, ad set and ad grain, with placement breakout and explicit measurement coverage.",
      },
      { property: "og:title", content: "Ads — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "Spend and cost per registration at four grains, each stating its row coverage before you click.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdsPage,
  errorComponent: ({ error, reset }) => (
    <RouteError error={error} reset={reset} subject="the ads view" where="src/routes/ads.tsx" />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

function AdsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/ads" });
  const { data: overview } = useSuspenseQuery(overviewQuery(search));
  const range = overview.range;
  const rangeDays = overview.coverage?.clippedDays;
  const grain: Grain = search.grain ?? "day";
  const { brief } = useDensityMode();
  // Owner rule, 21 Sep 2026: the per-ad view IS the point of this screen.
  const [adGrain, setAdGrain] = useState<AdGrain>("ad");
  const [drill, setDrill] = useState<{
    id: string;
    name: string;
    level: Exclude<AdGrain, "account">;
  } | null>(null);
  const [seeAll, setSeeAll] = useState(false);

  const setSearch = (next: Record<string, unknown>) =>
    void navigate({ search: (prev) => ({ ...prev, ...next }) });

  const ratioFlags = useQuery({
    queryKey: ["agency-ratio-flags"],
    queryFn: () => getAgencyRatioFlags(),
  });
  const ratiosComputable = ratioFlags.data?.codes ?? [];
  const ratiosValidFrom = ratioFlags.data?.validFrom ?? {};
  const scoped = overview.accounts.filter((a) => !search.agency || a.agency_code === search.agency);
  const views = scoped.map((r) => accountView(r, { rangeDays }));
  const priorViews = overview.priorAccounts
    .filter((a) => !search.agency || a.agency_code === search.agency)
    .map((r) => accountView(r, { rangeDays }));
  const t = computeTotals(views);
  const priorT = computeTotals(priorViews);
  // Same rule as Today: a change of measurement coverage is not a trend.
  const deltaGuard = coverageDeltaGuard(t, priorT, overview.coverage ?? null);

  const meta = useQuery({
    queryKey: ["ads-meta", range.since, range.until],
    queryFn: () => getAdsMeta({ data: { since: range.since, until: range.until } }),
  });

  const entities = useQuery({
    queryKey: ["entities", adGrain, range.since, range.until],
    queryFn: () =>
      getEntityRollup({
        data: {
          since: range.since,
          until: range.until,
          level: adGrain === "account" ? "campaign" : adGrain,
        },
      }),
    enabled: adGrain !== "account",
  });

  // One dataset, two renderers — the chart and the table cannot disagree.
  const buckets = bucketise(
    overview.series.map((r) => ({
      date: r.date,
      spend: fromObserved(r.spend),
      measured: fromObserved(r.measured_spend),
      leads: fromNullable(r.leads),
      measuredLeads: fromNullable(r.measured_leads),
    })),
    grain,
    range,
  ).map((b) => ({
    ...b,
    spend: sumMetrics(b.rows.map((r) => r.spend)),
    measuredSpend: sumMetrics(b.rows.map((r) => r.measured)),
    leads: sumMetrics(b.rows.map((r) => r.leads)),
    measuredLeads: sumMetrics(b.rows.map((r) => r.measuredLeads)),
  }));

  const chartRows = buckets.map((b) => ({
    label: b.label,
    spend: b.spend.value,
    measured: b.measuredSpend.value,
    incomplete: b.complete ? null : coverageLabel(b),
  }));

  const grainCounts = new Map(
    (meta.data?.grains ?? []).map((g) => [g.level, Number(g.rows_n) || 0] as const),
  );
  const entityViews = entities.isError ? [] : (entities.data?.rows ?? []).map(entityView);
  const { rankable, unrankable } = splitRankable(entityViews, (v) => v.cpl);
  rankable.sort((a, b) => (a.cpl.value ?? Infinity) - (b.cpl.value ?? Infinity));
  const ordered = [...rankable, ...unrankable];
  const shown = brief && !seeAll ? ordered.slice(0, BRIEF_ROWS) : ordered;

  return (
    <FilterScope
      agency={search.agency}
      ratiosComputable={ratiosComputable}
      ratiosValidFrom={ratiosValidFrom}
      rangeStart={range.since}
    >
      <AppShell
        topBar={
          <RangeBar
            showCompare
            title="Ads"
            search={search}
            range={range}
            onChange={(next) => setSearch(next)}
            right={
              brief ? null : <GrainSwitch grain={grain} onChange={(g) => setSearch({ grain: g })} />
            }
          />
        }
      >
        <div className="px-6 py-5">
          <section className="border-border bg-card grid grid-cols-2 rounded-md border md:grid-cols-4">
            <Kpi
              label="Meta spend"
              metric={t.spend}
              format="inr"
              provenance="meta_spend"
              prior={search.compare ? priorT.spend : undefined}
              suppressDelta={deltaGuard.suppress}
              suppressReason={deltaGuard.reason}
            />
            <Kpi
              label="Registrations (measured accounts)"
              metric={t.measuredLeads}
              format="int"
              provenance="registrations"
              hint="accounts with working lead tracking only"
              prior={search.compare ? priorT.measuredLeads : undefined}
              suppressDelta={deltaGuard.suppress}
              suppressReason={deltaGuard.reason}
            />
            <Kpi
              label="Cost per registration"
              metric={t.costPerMeasuredRegistration}
              format="inr"
              contract="cost_per_registration"
              prior={search.compare ? priorT.costPerMeasuredRegistration : undefined}
              suppressDelta={deltaGuard.suppress}
              suppressReason={deltaGuard.reason}
            />
            <Kpi
              label="Impressions"
              metric={t.impressions}
              format="int"
              prior={search.compare ? priorT.impressions : undefined}
              suppressDelta={deltaGuard.suppress}
              suppressReason={deltaGuard.reason}
            />
          </section>

          <CoverageLine totals={t} />
          <ProofLine ids={["meta_spend"]} />

          <div className="mt-4 space-y-4">
            <Figure
              id="ads-spend-series"
              title={`Spend · ${grain} buckets`}
              note={`solid = all spend · dashed = accounts with working lead tracking${search.agency ? " · this chart covers ALL accounts — it is not filtered by team" : ""}`}
              n={`${count(buckets.length)} ${grain} bucket${buckets.length === 1 ? "" : "s"}`}
              window={`${range.since} → ${range.until}`}
              excluded={
                buckets.some((b) => !b.complete)
                  ? "incomplete buckets are hatched and labelled with the days they hold — never dropped, never drawn solid"
                  : "nothing excluded — every bucket holds all the days it expects"
              }
              chart={
                chartRows.length === 0 ? (
                  <p className="py-10 text-center text-xs text-muted-foreground">{NO_DATA}</p>
                ) : (
                  <div className="h-[240px] px-2 py-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={chartRows}
                        margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
                      >
                        <CartesianGrid
                          stroke="var(--border)"
                          strokeDasharray="2 4"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="label"
                          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                        />
                        <YAxis
                          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                          tickFormatter={(v: number) => inrText(v)}
                          width={84}
                          domain={[0, "auto"]}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "var(--card)",
                            border: "1px solid var(--border)",
                            fontSize: 12,
                          }}
                          formatter={(v: number) => inrText(v)}
                        />
                        <Line
                          type="monotone"
                          dataKey="spend"
                          stroke="var(--primary)"
                          dot={false}
                          strokeWidth={2}
                        />
                        <Line
                          type="monotone"
                          dataKey="measured"
                          stroke="var(--positive)"
                          dot={false}
                          strokeWidth={1.5}
                          strokeDasharray="4 3"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )
              }
              table={
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                        <th className="text-left">Bucket</th>
                        <th className="text-right">Spend</th>
                        <th className="text-right">Measured spend</th>
                        <th className="text-right">Registrations (measured accounts)</th>
                        <th className="text-right">Cost per registration</th>
                        <th className="text-left">Coverage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {buckets.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                            {NO_DATA}
                          </td>
                        </tr>
                      ) : (
                        buckets.map((b) => (
                          <tr
                            key={b.key}
                            className="border-border border-b last:border-b-0 [&>td]:px-3 [&>td]:py-1.5"
                          >
                            <td className="font-medium">{b.label}</td>
                            <td className="nums text-right">
                              <MetricValue metric={b.spend} format="inr" />
                            </td>
                            <td className="nums text-right">
                              <MetricValue metric={b.measuredSpend} format="inr" />
                            </td>
                            <td className="nums text-right">
                              <MetricValue metric={b.measuredLeads} format="int" />
                            </td>
                            <td className="nums text-right">
                              <MetricValue
                                metric={divideMetrics(b.measuredSpend, b.measuredLeads)}
                                format="inr"
                              />
                            </td>
                            <td className="text-[11px] text-muted-foreground">
                              {b.complete ? `${b.daysCovered} days` : coverageLabel(b)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              }
            />

            <section className="border-border bg-card rounded-md border">
              <div className="border-border flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Performance by grain
                </h2>
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  {GRAINS.map((g) => {
                    const rows =
                      g === "account" ? views.length : (grainCounts.get(g as "campaign") ?? null);
                    const thin = rows !== null && rows > 0 && rows < 30;
                    return (
                      <button
                        key={g}
                        onClick={() => {
                          setAdGrain(g);
                          setSeeAll(false);
                        }}
                        aria-pressed={adGrain === g}
                        className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                          adGrain === g
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {GRAIN_LABEL[g]}{" "}
                        <span className="opacity-80">
                          (
                          {meta.isLoading && g !== "account"
                            ? "counting…"
                            : rows === null
                              ? "coverage unknown"
                              : rows === 0
                                ? "0 rows · nothing collected"
                                : `${count(rows)} rows${thin ? " · thin" : ""}`}
                          )
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {search.agency && adGrain !== "account" ? (
                <p className="border-b border-border bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                  Campaign, ad-set and ad rows below cover ALL accounts — they carry no team code,
                  so this list is not filtered by team.
                </p>
              ) : null}
              {adGrain === "ad" ? (
                <AdPerformanceTable days={14} sort="spend" />
              ) : adGrain === "account" ? (
                <AccountsTable views={views} totals={t} />
              ) : entities.isLoading ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</p>
              ) : entities.isError ? (
                <SectionUnavailable
                  title={GRAIN_LABEL[adGrain]}
                  detail={entities.error instanceof Error ? entities.error.message : null}
                  className="m-4"
                />
              ) : ordered.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No {GRAIN_LABEL[adGrain].toLowerCase()} rows were collected for this window. That
                  is an absence of data, not a set of entities that spent nothing.
                </p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                          <th className="text-left">Name</th>
                          {brief ? null : <th className="text-left">Account</th>}
                          <th className="text-right">Spend</th>
                          {brief ? null : <th className="text-right">Impressions</th>}
                          {brief ? null : <th className="text-right">Landing page views</th>}
                          <th className="text-right">Registrations</th>
                          <th className="text-right">Cost per registration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((v, i) => {
                          const isTerminal =
                            i === rankable.length && unrankable.length > 0 && !(brief && !seeAll);
                          return (
                            <Fragment key={v.row.entity_id}>
                              {isTerminal ? (
                                <tr key={`sep-${v.row.entity_id}`}>
                                  <td
                                    colSpan={brief ? 4 : 7}
                                    className="border-border bg-muted/40 border-y px-3 py-1.5 text-center text-[10px] uppercase tracking-wider text-muted-foreground"
                                  >
                                    — {count(unrankable.length)} cannot be ranked —
                                  </td>
                                </tr>
                              ) : null}
                              <tr
                                key={v.row.entity_id}
                                onClick={() =>
                                  setDrill({
                                    id: v.row.entity_id,
                                    name: v.row.entity_name ?? v.row.entity_id,
                                    level: adGrain as Exclude<AdGrain, "account">,
                                  })
                                }
                                className={`border-border hover:bg-muted/50 cursor-pointer border-b last:border-b-0 [&>td]:px-3 ${
                                  brief ? "[&>td]:py-2.5" : "[&>td]:py-1.5"
                                }`}
                              >
                                <td
                                  className="max-w-[360px] truncate font-medium"
                                  title={v.row.entity_name ?? v.row.entity_id}
                                >
                                  {v.row.entity_name ?? v.row.entity_id}
                                </td>
                                {brief ? null : (
                                  <td className="text-[11px] text-muted-foreground">
                                    {v.row.account_name ?? v.row.account_id}
                                  </td>
                                )}
                                <td className="nums text-right">
                                  <MetricValue metric={v.spend} format="inr" emphasis />
                                </td>
                                {brief ? null : (
                                  <td className="nums text-right">
                                    <MetricValue metric={v.impressions} format="int" />
                                  </td>
                                )}
                                {brief ? null : (
                                  <td className="nums text-right">
                                    <MetricValue metric={v.landingPageViews} format="int" />
                                  </td>
                                )}
                                <td className="nums text-right">
                                  <MetricValue metric={v.leads} format="int" />
                                </td>
                                <td className="nums text-right">
                                  <MetricValue metric={v.cpl} format="inr" />
                                </td>
                              </tr>
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="border-border flex items-center justify-between border-t px-4 py-2 text-[11px] text-muted-foreground">
                    <span>
                      {count(shown.length)} of {count(ordered.length)} rows ·{" "}
                      {count(unrankable.length)} cannot be ranked · click a row to drill down
                    </span>
                    {brief && !seeAll && ordered.length > BRIEF_ROWS ? (
                      <button
                        onClick={() => setSeeAll(true)}
                        className="underline underline-offset-4 hover:text-foreground"
                      >
                        see all {count(ordered.length)}
                      </button>
                    ) : null}
                  </div>
                </>
              )}
            </section>

            <PlacementFigure
              rows={meta.data?.placements ?? []}
              missing={meta.data ? meta.data.placementRowsMissing : 0}
              total={meta.data ? meta.data.placementRowsTotal : 0}
              loading={meta.isLoading}
              window={`${range.since} → ${range.until}`}
            />
          </div>
        </div>

        {drill ? (
          <DrillDrawer
            entityId={drill.id}
            name={drill.name}
            level={drill.level}
            since={range.since}
            until={range.until}
            onClose={() => setDrill(null)}
          />
        ) : null}
      </AppShell>
    </FilterScope>
  );
}

function PlacementFigure({
  rows,
  missing,
  total,
  loading,
  window: win,
}: {
  rows: import("@/lib/ads.functions").PlacementRow[];
  missing: number;
  total: number;
  loading: boolean;
  window: string;
}) {
  const views = rows.map((r) => {
    const spend = fromObserved(r.spend);
    const leads = fromNullable(r.leads, "Meta reported no registration count for this placement");
    return {
      placement: r.placement,
      spend,
      leads,
      impressions: fromNullable(r.impressions),
      clicks: fromNullable(r.link_clicks),
      cpl: divideMetrics(spend, leads),
      ctr: rate(fromNullable(r.link_clicks), fromNullable(r.impressions), { min: 1000 }),
    };
  });
  views.sort((a, b) => (b.spend.value ?? -Infinity) - (a.spend.value ?? -Infinity));

  const coverageNote =
    total === 0
      ? "No Meta rows at all were collected in this window, so there is nothing to break out."
      : rows.length === 0
        ? `No placement breakdown has been synced. All ${count(total)} Meta rows in this window carry a null placement, because the sync requests insights without the publisher_platform / platform_position breakdown. Until that breakdown is pulled, no statement about Reels versus Feed versus Stories is knowable from this database — and none is shown.`
        : missing > 0
          ? `${count(missing)} of ${count(total)} rows in this window carry no placement and are excluded from the split below. Read the shares against that, not against total spend.`
          : null;

  const thin = rows.length > 0 && rows.length < 3;

  // Nothing to break out: one honest line, not an empty figure with a chart
  // toggle, a header and a footer wrapped around no rows at all.
  if (rows.length === 0) {
    return (
      <p className="border-border bg-card rounded-md border px-4 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
        <span className="font-semibold uppercase tracking-wider text-[10px] mr-2">
          Placement breakout
        </span>
        {loading ? "Checking placement coverage…" : coverageNote}
      </p>
    );
  }

  return (
    <Figure
      id="ads-placement"
      title="Placement breakout"
      note="Reels · Feed · Stories, straight from the synced rows"
      n={`${count(rows.length)} placement${rows.length === 1 ? "" : "s"}`}
      window={win}
      excluded={
        missing > 0
          ? `${count(missing)} rows with no placement value excluded`
          : rows.length === 0
            ? "everything — no placement breakdown exists in the database"
            : "nothing excluded"
      }
      chart={
        rows.length === 0 ? undefined : (
          <div className="h-[240px] px-2 py-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={views.map((v) => ({ placement: v.placement, cpl: v.cpl.value }))}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
                <XAxis
                  dataKey="placement"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v: number) => inrText(v)}
                  width={84}
                  domain={[0, "auto"]}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    fontSize: 12,
                  }}
                  formatter={(v: number) => inrText(v)}
                />
                <Bar dataKey="cpl" fill="var(--primary)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )
      }
      table={
        <div>
          {coverageNote ? (
            <p className="border-warning/40 bg-warning/10 m-4 rounded border px-3 py-2 text-[12px]">
              {loading ? "Checking placement coverage…" : coverageNote}
            </p>
          ) : null}
          {thin ? (
            <p className="mx-4 mb-2 text-[11px] text-warning">
              Only {count(rows.length)} placements reported — too few to read as a distribution.
            </p>
          ) : null}
          {rows.length === 0 ? null : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                    <th className="text-left">Placement</th>
                    <th className="text-right">Spend</th>
                    <th className="text-right">Impressions</th>
                    <th className="text-right">Link clicks</th>
                    <th className="text-right">Click rate</th>
                    <th className="text-right">Registrations</th>
                    <th className="text-right">Cost per registration</th>
                  </tr>
                </thead>
                <tbody>
                  {views.map((v) => (
                    <tr
                      key={v.placement}
                      className="border-border border-b last:border-b-0 [&>td]:px-3 [&>td]:py-1.5"
                    >
                      <td className="font-medium">{v.placement}</td>
                      <td className="nums text-right">
                        <MetricValue metric={v.spend} format="inr" />
                      </td>
                      <td className="nums text-right">
                        <MetricValue metric={v.impressions} format="int" />
                      </td>
                      <td className="nums text-right">
                        <MetricValue metric={v.clicks} format="int" />
                      </td>
                      <td className="nums text-right">
                        <MetricValue metric={v.ctr} format="percent" />
                      </td>
                      <td className="nums text-right">
                        <MetricValue metric={v.leads} format="int" />
                      </td>
                      <td className="nums text-right">
                        <MetricValue metric={v.cpl} format="inr" emphasis />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      }
    />
  );
}

/** Drilling never navigates away for a single row. */
function DrillDrawer({
  entityId,
  name,
  level,
  since,
  until,
  onClose,
}: {
  entityId: string;
  name: string;
  level: "campaign" | "adset" | "ad";
  since: string;
  until: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["entity-drill", entityId, level, since, until],
    queryFn: () => getEntityDrill({ data: { entityId, level, since, until } }),
  });

  const trend = (data?.trend ?? []).slice(-30).map((r) => ({
    date: r.date.slice(5),
    spend: fromObserved(r.spend).value,
  }));
  const children = (data?.children ?? []).map(entityView);
  children.sort((a, b) => (b.spend.value ?? -Infinity) - (a.spend.value ?? -Infinity));

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button
        aria-label="Close drill-down"
        onClick={onClose}
        className="bg-background/60 flex-1 backdrop-blur-[1px]"
      />
      <aside className="border-border bg-card flex h-full w-full max-w-[560px] flex-col overflow-y-auto border-l shadow-xl">
        <div className="border-border sticky top-0 flex items-start gap-3 border-b bg-card px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{level}</div>
            <div className="truncate text-sm font-semibold" title={name}>
              {name}
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <div>
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Last 30 collected days of spend
            </h3>
            {isLoading ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
            ) : trend.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                No daily rows exist for this entity.
              </p>
            ) : (
              <div className="mt-2 h-[150px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                      tickFormatter={(v: number) => inrText(v)}
                      width={70}
                      domain={[0, "auto"]}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--card)",
                        border: "1px solid var(--border)",
                        fontSize: 12,
                      }}
                      formatter={(v: number) => inrText(v)}
                    />
                    <Line
                      type="monotone"
                      dataKey="spend"
                      stroke="var(--primary)"
                      dot={false}
                      strokeWidth={2}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div>
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {data?.childLevel
                ? `Children · ${data.childLevel} (${count(children.length)})`
                : "Children"}
            </h3>
            {!data?.childLevel ? (
              <p className="mt-2 text-xs text-muted-foreground">
                An ad is the finest grain synced — there is nothing below it.
              </p>
            ) : children.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                No {data.childLevel} rows were collected for this entity in this window.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="mt-2 w-full text-[12px]">
                  <thead>
                    <tr className="border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:py-1.5 [&>th]:font-medium">
                      <th className="text-left">Name</th>
                      <th className="text-right">Spend</th>
                      <th className="text-right">Regs</th>
                      <th className="text-right">Cost/reg</th>
                    </tr>
                  </thead>
                  <tbody>
                    {children.map((c) => (
                      <tr
                        key={c.row.entity_id}
                        className="border-border border-b last:border-b-0 [&>td]:py-1.5"
                      >
                        <td
                          className="max-w-[240px] truncate"
                          title={c.row.entity_name ?? c.row.entity_id}
                        >
                          {c.row.entity_name ?? c.row.entity_id}
                        </td>
                        <td className="nums text-right">
                          <MetricValue metric={c.spend} format="inr" />
                        </td>
                        <td className="nums text-right">
                          <MetricValue metric={c.leads} format="int" />
                        </td>
                        <td className="nums text-right">
                          <MetricValue metric={c.cpl} format="inr" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {data?.error ? (
            <p className="text-xs text-destructive" role="alert">
              <UiError detail={data.error} where={"src/routes/ads.tsx"} />
            </p>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
