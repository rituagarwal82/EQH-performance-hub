import { DENSITIES, GRAINS, type Density, type Grain } from "@/lib/view-prefs";
import { useDensityMode } from "@/components/DensityProvider";
import { queryOptions, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { UiError, RouteError } from "@/components/UiError";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { X } from "lucide-react";
import { useState } from "react";

import { AgencyRollup } from "@/components/AgencyRollup";
import { AgencyLeadCounts } from "@/components/AgencyLeadCounts";

import { LEDGER_REBUILD_PHRASE } from "@/lib/ledger-confirm";
import { AppShell } from "@/components/AppShell";
import { Kpi } from "@/components/Kpi";
import { Disclosure } from "@/components/Disclosure";
import { DataMenu } from "@/components/DataMenu";

import { Figure } from "@/components/Figure";
import { AttributionSections } from "@/components/AttributionSections";
import { Provenance } from "@/components/Provenance";
import { contractFor, contractTitle } from "@/lib/contracts";
import { formatINR, formatInt, NO_DATA } from "@/lib/format";
import { MetricValue } from "@/components/MetricValue";
import { RangeBar, type RangeSearch } from "@/components/RangeBar";
import { StaleBadge } from "@/components/StaleBadge";
import { ProofLine } from "@/components/VerifiedMark";

import { Button } from "@/components/ui/button";
import { count, inrText } from "@/lib/counts";
import { DEFAULT_PRESET, resolveRange, type RangePreset } from "@/lib/date-range";
import { getPriceMix } from "@/lib/promotions.functions";
import {
  getDayReconciliation,
  getRevenue,
  getSalesReconciliation,
  getTierRollup,
  syncLedger,
  type DayReconciliation,
  type ReconRow,
  type RevenueData,
  type TierRow,
} from "@/lib/ledger.functions";
import { BUCKET_LABEL, getSaleTiming } from "@/lib/sale-timing.functions";
import { fromNullable, fromObserved, measured, toNum, unmeasured, type Metric } from "@/lib/metric";

const TIERS = [
  { id: "L1_SILVER", label: "L1 Silver" },
  { id: "L2", label: "L2" },
  { id: "L3_DIAMOND", label: "L3 Diamond" },
  { id: "L4", label: "L4" },
  { id: "OTHER", label: "Other" },
] as const;

type TierId = (typeof TIERS)[number]["id"];

const tierLabel = (id: string) => TIERS.find((t) => t.id === id)?.label ?? id;

type RevenueSearch = RangeSearch & { tier?: TierId };

const revenueQuery = (since: string, until: string, tier: string) =>
  queryOptions({
    queryKey: ["ledger-revenue", since, until, tier],
    queryFn: () => getRevenue({ data: { since, until, tier } }),
  });

const reconQuery = (since: string, until: string) =>
  queryOptions({
    queryKey: ["sales-reconciliation", since, until],
    queryFn: () => getSalesReconciliation({ data: { since, until } }),
  });

const dayReconQuery = (date: string) =>
  queryOptions({
    queryKey: ["day-reconciliation", date],
    queryFn: () => getDayReconciliation({ data: { date } }),
  });

const tierQuery = (since: string, until: string) =>
  queryOptions({
    queryKey: ["ledger-tiers", since, until],
    queryFn: () => getTierRollup({ data: { since, until } }),
  });

export const Route = createFileRoute("/_authenticated/sales")({
  validateSearch: (search: Record<string, unknown>): RevenueSearch => ({
    range: (search["range"] as RangePreset) ?? DEFAULT_PRESET,
    since: search["since"] as string | undefined,
    until: search["until"] as string | undefined,
    compare: search["compare"] === true,
    ...(typeof search["agency"] === "string" && search["agency"]
      ? { agency: search["agency"] }
      : {}),
    ...((GRAINS as readonly string[]).includes(String(search["grain"]))
      ? { grain: search["grain"] as Grain }
      : {}),
    ...((DENSITIES as readonly string[]).includes(String(search["view"]))
      ? { view: search["view"] as Density }
      : {}),
    tier: (search["tier"] as TierId) ?? "L1_SILVER",
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps }) => {
    const r = resolveRange(deps.range ?? DEFAULT_PRESET, {
      since: deps.since,
      until: deps.until,
    });
    await Promise.all([
      context.queryClient.ensureQueryData(revenueQuery(r.since, r.until, deps.tier ?? "L1_SILVER")),
      context.queryClient.ensureQueryData(tierQuery(r.since, r.until)),
      context.queryClient.ensureQueryData(reconQuery(r.since, r.until)),
      context.queryClient.ensureQueryData(dayReconQuery(r.until)),
    ]);
  },
  head: () => ({
    meta: [
      { title: "Sales — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Collections from the accounts team's ledger across every tier: sales counted by New Sale Tagging, money collected by rail, when each sale lands relative to the webinar, and gross cost per sale against Meta spend.",
      },
      { property: "og:title", content: "Sales — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "The accounts ledger is the source of truth for every rupee collected and every sale counted.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RevenuePage,
  errorComponent: ({ error, reset }) => (
    <RouteError error={error} reset={reset} subject="the sales view" where="src/routes/sales.tsx" />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

function RevenuePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const range = resolveRange(search.range, { since: search.since, until: search.until });
  const tier: TierId = search.tier ?? "L1_SILVER";
  const { data } = useSuspenseQuery(revenueQuery(range.since, range.until, tier));
  const { data: tiers } = useSuspenseQuery(tierQuery(range.since, range.until));
  const { data: recon } = useSuspenseQuery(reconQuery(range.since, range.until));
  const { data: dayRecon } = useSuspenseQuery(dayReconQuery(range.until));
  const { density } = useDensityMode();
  const queryClient = useQueryClient();
  const runSync = useServerFn(syncLedger);
  const [progress, setProgress] = useState<string | null>(null);
  const [drillTier, setDrillTier] = useState<string | null>(null);

  const d: RevenueData = data;
  const hasData = d.totals.rows > 0;
  const m = (v: number) => (hasData ? measured(v) : unmeasured("no ledger rows in this range"));

  /**
   * Outstanding below zero on the L3 Diamond tier means the sheet carries more
   * received than owed on some rows. Owner's decision: Diamond collections are
   * out of scope for this engine and move to the accounting system, so the
   * figure is rendered honestly and unaltered, with no warning tone and no
   * open question for the accounts team.
   */
  const outstanding = (v: number | string | null): Metric => {
    const base = fromObserved(v);
    if (base.value === null || base.value >= 0) return base;
    return {
      ...base,
      note: "Out of scope for this engine — Diamond collections will be handled by the accounting system.",
    };
  };

  const isL1 = tier === "L1_SILVER";
  const reconByDate = new Map<string, ReconRow>(recon.map((r) => [r.date, r]));
  const settlingDays = recon.filter((r) => r.settling).length;
  const reviewDays = recon.filter((r) => r.review);

  /**
   * The accounts ledger is hand-entered 1–2 days behind. Any window whose end
   * sits inside that lag renders money as `partial` — a floor, never the
   * window's revenue. One typed row must never make a day look covered.
   */
  const windowSettling =
    isL1 && Math.round((Date.now() - new Date(`${d.until}T00:00:00Z`).getTime()) / 86400000) <= 3;
  const money = (v: number): Metric => {
    const base = m(v);
    if (!windowSettling || base.value === null) return base;
    return {
      ...base,
      state: "partial",
      note: "the accounts ledger is typically entered 1\u20132 days behind — collections for recent days will rise",
    };
  };

  const dayMoney = (date: string, v: number | string | null): Metric => {
    const base = fromObserved(v);
    const row = reconByDate.get(date);
    if (!row?.settling || base.value === null) return base;
    return {
      ...base,
      state: "partial",
      note: "still settling — the accounts ledger is typically entered 1\u20132 days behind",
    };
  };

  const sync = async (restart: boolean): Promise<string> => {
    setProgress("Reading the Inflow tab\u2026");
    try {
      let written = 0;
      let swapped = "";
      for (let pass = 0; pass < 40; pass += 1) {
        const result = await runSync({
          data: {
            restart: restart && pass === 0,
            ...(restart && pass === 0 ? { confirm: LEDGER_REBUILD_PHRASE } : {}),
          },
        });
        if (result.status === "error") {
          setProgress(result.error ?? null);
          throw new Error(result.error ?? "Ledger import failed");
        }
        written = result.rowsWritten;
        setProgress(`${count(written)} rows read`);
        if (!result.hasMore) {
          if (result.swap) {
            swapped = `replaced ${count(result.swap.previous_rows)} rows with ${count(
              result.swap.new_rows,
            )}`;
          }
          break;
        }
      }
      await queryClient.invalidateQueries({ queryKey: ["ledger-revenue"] });
      await queryClient.invalidateQueries({ queryKey: ["ledger-tiers"] });
      await queryClient.invalidateQueries({ queryKey: ["ledger-unassigned"] });
      return swapped
        ? `Ledger re-imported \u2014 ${swapped}`
        : `Ledger imported \u2014 ${count(written)} rows`;
    } finally {
      setProgress(null);
    }
  };

  const gf = d.goForward;

  /** Meta spend for a calendar month, or unmeasured when no month row exists. */
  const monthSpend = (period: string): Metric => {
    const row = d.monthlySpend.find((s) => s.period === period);
    return row ? measured(row.spend) : unmeasured("no Meta spend rows for this month");
  };

  return (
    <AppShell
      topBar={
        <RangeBar
          title="Sales"
          search={search}
          range={range}
          onChange={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
          right={
            <>
              {progress ? (
                <span className="max-w-[280px] truncate font-mono text-[11px] text-muted-foreground">
                  {progress}
                </span>
              ) : null}
              <DataMenu
                actions={[
                  {
                    key: "ledger",
                    label: "Import ledger",
                    description: "Reads new rows from the accounts team's Inflow tab.",
                    run: () => sync(false),
                  },
                  {
                    key: "ledger-full",
                    label: "Full re-import",
                    description: "Replaces the ledger with a fresh read of the whole tab.",
                    confirm:
                      "This reads every row of the accounts sheet into a holding area, then replaces the entire collections ledger with it \u2014 rows no longer in the sheet will be gone. Nothing is replaced unless the whole read succeeds, and the swap is refused if it would lose more than a few percent of the money on record. It can take several minutes.",
                    typeToConfirm: LEDGER_REBUILD_PHRASE,
                    run: () => sync(true),
                  },
                ]}
              />
            </>
          }
        />
      }
    >
      <div className="space-y-4 px-6 py-4">
        <header className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-base font-semibold tracking-tight">{tierLabel(tier)} collections</h1>
          <span className="text-[11px] text-muted-foreground">
            {d.since} → {d.until} · source of truth: accounts ledger (Inflow tab)
            {d.lastSync ? ` · imported ${d.lastSync.slice(0, 16).replace("T", " ")}` : ""}
          </span>
          <StaleBadge source="ledger" what="Collections" />
          <StaleBadge source="cron" what="Meta spend" />
          <ProofLine ids={["sales_count", "ledger_closed_months"]} className="w-full" />
        </header>

        <MaturationBanner until={d.until} />

        {!d.connected ? (
          <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px]">
            The accounts spreadsheet is not connected yet. Until it is, this screen shows only what
            has already been imported — nothing here is estimated.
          </div>
        ) : null}

        {d.error ? (
          <UiError
            detail={d.error}
            subject="the sales figures"
            where="src/routes/sales.tsx"
            className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2"
          />
        ) : null}

        <p className="text-[15px] leading-snug">
          <span className="font-semibold">
            <MetricValue metric={m(d.totals.sales)} /> {tierLabel(tier)} sale
            {d.totals.sales === 1 ? "" : "s"}
          </span>{" "}
          ·{" "}
          <span className="font-semibold">
            <MetricValue metric={money(d.totals.collected)} format="inr" /> collected
          </span>{" "}
          ·{" "}
          <span className="font-semibold">
            <MetricValue metric={outstanding(hasData ? d.totals.pending : null)} format="inr" />{" "}
            outstanding
          </span>
          <span className="text-muted-foreground">
            {" "}
            · {windowSettling ? "this window is still settling" : "this window has settled"}
          </span>
        </p>

        <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Kpi
            variant="card"
            label={`${tierLabel(tier)} sales`}
            metric={m(d.totals.sales)}
            provenance="sales_count"
            hint="sum of New Sale Tagging"
          />
          <Kpi
            variant="card"
            label={`Money collected — ${tierLabel(tier)} (all sources)`}
            metric={money(d.totals.collected)}
            format="inr"
            provenance="collected"
            hint={`actual money received for ${tierLabel(tier)}, all payment routes — includes buyers who never came through an ad and instalments from earlier sales, so it is not an ad-performance figure`}
          />
          <Kpi
            variant="card"
            label="Outstanding"
            metric={outstanding(hasData ? d.totals.pending : null)}
            format="inr"
            hint="Amount Pending on ledger rows"
          />
          <Kpi
            variant="card"
            label="Payment rows"
            metric={m(d.totals.rows)}
            hint={hasData ? `${count(d.totals.buyers)} distinct buyers` : undefined}
          />
        </section>

        {isL1 && d.seats && (d.seats.bookings > 0 || d.seats.openHeld > 0) ? (
          <p className="text-[13px] leading-snug text-muted-foreground">
            <span className="font-semibold text-foreground">
              {count(d.seats.openHeld)} held seat{d.seats.openHeld === 1 ? "" : "s"}
            </span>{" "}
            open today · {inrText(d.seats.openDeposits)} deposits received ·{" "}
            {inrText(d.seats.openBalance)} balance outstanding. A Book My Seat deposit is not a sale
            — it becomes one when the balance is paid, and is counted on the day of that payment.
            Deposits are still real money and stay inside the cash figures above.{" "}
            {d.seats.bookings > 0 && d.seats.completionRate !== null
              ? `${count(d.seats.completed)} of ${count(d.seats.bookings)} seats booked in this window have completed (${d.seats.completionRate}%${
                  d.seats.medianDays === null ? "" : `, median ${d.seats.medianDays} days`
                }).`
              : null}
          </p>
        ) : null}

        {isL1 ? (
          <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Kpi
              variant="card"
              contract="cost_per_sale"
              label="Cost per sale"
              metric={fromNullable(d.canonicalCostPerSale?.value ?? null)}
              format="inr"
              hint={
                d.canonicalCostPerSale
                  ? `${inrText(d.canonicalCostPerSale.spend)} total Meta spend ÷ ${count(d.canonicalCostPerSale.sales)} paid-attributed ledger sales`
                  : "no spend or sales in this window"
              }
              tone="primary"
            />
            <Kpi
              variant="card"
              label="Paid front-end ROAS (ex-GST) — go-forward"
              metric={fromNullable(gf.roas)}
              format="ratio"
              provenance="front_end_roas"
              hint={
                d.paid
                  ? `${inrText(d.paid.paidExGst)} ad-attributed new-sale cash ex-GST ÷ ${inrText(gf.spend)} Meta spend · excludes ${inrText(d.paid.noLead)} from buyers with no lead record and ${inrText(d.paid.instalment)} of instalments${d.paid.all > 0 && d.paid.paidGross / d.paid.all >= 0.95 ? " · WARNING: within 5% of all L1 cash — attribution coverage has collapsed" : ""}`
                  : "no ledger collections in this window"
              }
              note={
                d.paid && d.paid.unsyncedGross > 0
                  ? `${inrText(d.paid.unsyncedGross)} from teams whose ad spend is not yet connected — excluded from this ratio, shown in team counts`
                  : undefined
              }
              tone="primary"
            />
            <Kpi
              variant="card"
              label="Spend per ledger sale — context only"
              metric={fromNullable(d.all.costPerSale)}
              format="inr"
              hint={`${inrText(d.all.spend)} all-account spend ÷ ${count(d.all.sales)} ledger L1 sales · not the cost-per-sale metric, no attribution join`}
            />
            <Kpi
              variant="card"
              label="Spend by teams no longer running"
              metric={fromNullable(d.terminated.spend)}
              format="inr"
              hint="money spent in this window by teams that have since stopped — sales cannot yet be split by team, so only the spend is shown"
            />
          </section>
        ) : (
          <p className="rounded border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
            Cost per sale and ROAS are not shown for {tierLabel(tier)}: Meta spend buys L1
            registrations, and charging it against a back-end tier would invent an attribution the
            data does not support.
          </p>
        )}

        <section>
          <h2 className="mb-1 text-[12px] font-semibold">Collections by tier</h2>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-[12px]">
              <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Tier</th>
                  <th className="px-3 py-1.5 text-right font-medium">Sales</th>
                  <th className="px-3 py-1.5 text-right font-medium">Buyers</th>
                  <th className="px-3 py-1.5 text-right font-medium">Collected</th>
                  <th className="px-3 py-1.5 text-right font-medium">Avg ticket</th>
                  <th className="px-3 py-1.5 text-right font-medium">Outstanding</th>
                  <th className="px-3 py-1.5 text-right font-medium">Rows</th>
                </tr>
              </thead>
              <tbody>
                {tiers.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-2 py-6 text-center text-muted-foreground">
                      {NO_DATA}
                    </td>
                  </tr>
                ) : (
                  tiers.map((t) => (
                    <tr
                      key={t.product_tier}
                      onClick={() => setDrillTier(t.product_tier)}
                      className={`cursor-pointer border-t border-border/60 hover:bg-muted/40 ${
                        t.product_tier === tier ? "bg-primary/5" : ""
                      }`}
                    >
                      <td className="px-3 py-1">{tierLabel(t.product_tier)}</td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromObserved(t.sales)} />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromObserved(t.buyers)} />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromObserved(t.collected)} format="inr" />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromNullable(t.avg_ticket)} format="inr" />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={outstanding(t.pending)} format="inr" />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromObserved(t.rows_count)} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Every tier the ledger carries, on the same counting rule. Click a row to open it beside
            the screen. Meta spend is a front-end (L1) cost, so cost per sale and ROAS are only
            meaningful on L1 Silver.
          </p>
        </section>

        <Disclosure
          title="How these numbers are counted"
          teaser="New Sale Tagging is the sale · the ledger is the money · gross basis, no deductions"
        >
          <div className="space-y-2 text-[11px] text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Counting rule in force:</span> a sale is
              a row the accounts team tagged{" "}
              <span className="font-medium text-foreground">New Sale Tagging = 1</span>. Their
              deduplication of instalments against first payments is authoritative and is never
              recomputed here. TagMango is kept only for entitlement — what a person has access to —
              never for money.
            </p>
            <p>
              <span className="font-medium text-foreground">Attribution rule:</span> paid front-end
              ROAS counts only new-sale cash from buyers whose lead record came through a paid ad,
              divided by 1.18 to strip GST. Cash from buyers with no lead record and from
              instalments on earlier sales is held out of the ratio and shown separately.
            </p>
            <p>
              <span className="font-medium text-foreground">Gross basis by instruction:</span> no
              platform fees, agency commission, delivery cost or refunds are deducted at this
              reporting level.
            </p>
            <p>
              <span className="font-medium text-foreground">The two cost-per-sale figures use
              different denominators.</span> Cost per Meta sale divides Meta spend only by the sales
              whose buyer came from a Meta ad. Cost per sale across every source divides the same
              Meta spend by every L1 sale in range, whatever brought the buyer in. They answer
              different questions and will not agree.
            </p>
            <p>
              <span className="font-medium text-foreground">Google Ads is not running.</span>{" "}
              Leads tagged google are organic search and old campaign links — no media cost. They
              are counted as an organic search channel, not as paid traffic, and the sales they
              produce cost nothing in media.
            </p>


          </div>
        </Disclosure>

        <SaleTimingFigure since={range.since} until={range.until} tier={tier} />

        <Disclosure
          title="Attribution & teams"
          teaser="where the money came from, and what each team's leads did"
          defaultOpen={density === "working"}
        >
          <div className="space-y-4">
            {isL1 ? <AttributionSections since={range.since} until={range.until} /> : null}
            <AgencyRollup since={range.since} until={range.until} />
            <AgencyLeadCounts since={range.since} until={range.until} />
          </div>
        </Disclosure>

        {density === "working" ? (
          <section>
            <h2 className="mb-1 text-[12px] font-semibold">Payment rails</h2>
            <div className="overflow-x-auto rounded border border-border">
              <table className="w-full text-[12px]">
                <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">Rail</th>
                    <th className="px-3 py-1.5 text-right font-medium">Rows</th>
                    <th className="px-3 py-1.5 text-right font-medium">Share</th>
                    <th className="px-3 py-1.5 text-right font-medium">Collected</th>
                  </tr>
                </thead>
                <tbody>
                  {d.byRail.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-2 py-6 text-center text-muted-foreground">
                        {NO_DATA}
                      </td>
                    </tr>
                  ) : (
                    d.byRail.map((r) => (
                      <tr
                        key={r.receipt_source}
                        className="border-t border-border/60 hover:bg-muted/40"
                      >
                        <td className="px-3 py-1">{r.receipt_source}</td>
                        <td className="px-3 py-1 text-right font-mono tabular-nums">
                          <MetricValue metric={fromObserved(r.rows_count)} />
                        </td>
                        <td className="px-3 py-1 text-right font-mono tabular-nums">
                          <MetricValue metric={fromNullable(toNum(r.share_pct))} format="percent" />
                        </td>
                        <td className="px-3 py-1 text-right font-mono tabular-nums">
                          <MetricValue metric={fromObserved(r.collected)} format="inr" />
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              The rail is only the buyer's preferred payment method — offline and online money lands
              on the same day, so no collection lag is modelled.
            </p>
          </section>
        ) : null}

        <section>
          <h2 className="mb-1 text-[12px] font-semibold">Monthly</h2>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-[12px]">
              <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Month</th>
                  <th className="px-3 py-1.5 text-right font-medium">New sales</th>
                  <th className="px-3 py-1.5 text-right font-medium">Distinct buyers</th>
                  <th className="px-3 py-1.5 text-right font-medium">Collected</th>
                  <th className="px-3 py-1.5 text-right font-medium">Meta spend</th>
                </tr>
              </thead>
              <tbody>
                {d.monthly.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">
                      {NO_DATA}
                    </td>
                  </tr>
                ) : (
                  d.monthly.map((mo) => (
                    <tr key={mo.period} className="border-t border-border/60 hover:bg-muted/40">
                      <td className="px-3 py-1 font-mono tabular-nums">{mo.period}</td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromObserved(mo.sales)} />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromObserved(mo.buyers)} />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromObserved(mo.collected)} format="inr" />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={monthSpend(mo.period)} format="inr" />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {isL1 && density === "working" ? (
          <>
            <Reconciliation rows={recon} settlingDays={settlingDays} reviewDays={reviewDays} />
            <DayNameByName data={dayRecon} />
            <PriceMix since={range.since} until={range.until} />
          </>
        ) : null}

        <section>
          <h2 className="mb-1 text-[12px] font-semibold">Daily</h2>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-[12px]">
              <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Business day</th>
                  <th className="px-3 py-1.5 text-right font-medium">Sales (TagMango)</th>
                  <th className="px-3 py-1.5 text-right font-medium">New sales (ledger)</th>
                  <th className="px-3 py-1.5 text-right font-medium">Collected</th>
                  <th className="px-3 py-1.5 text-right font-medium">Outstanding</th>
                  <th className="px-3 py-1.5 text-right font-medium">Rows</th>
                </tr>
              </thead>
              <tbody>
                {d.daily.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                      {NO_DATA}
                    </td>
                  </tr>
                ) : (
                  d.daily.map((r) => (
                    <tr
                      key={r.business_date}
                      className="border-t border-border/60 hover:bg-muted/40"
                    >
                      <td className="px-3 py-1 font-mono tabular-nums">
                        {r.business_date}
                        {reconByDate.get(r.business_date)?.settling ? (
                          <span
                            className="ml-1.5 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400"
                            title="still settling — the accounts ledger is typically entered 1–2 days behind"
                          >
                            settling
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue
                          metric={fromNullable(
                            toNum(reconByDate.get(r.business_date)?.tm_sales ?? null),
                          )}
                        />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={dayMoney(r.business_date, r.sales)} />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={dayMoney(r.business_date, r.collected)} format="inr" />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromObserved(r.pending)} format="inr" />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromObserved(r.rows_count)} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {drillTier ? (
        <TierDrawer
          row={tiers.find((t) => t.product_tier === drillTier) ?? null}
          label={tierLabel(drillTier)}
          scoped={drillTier === tier}
          selectable={TIERS.some((x) => x.id === drillTier)}
          window={`${d.since} → ${d.until}`}
          onScope={() => {
            void navigate({ search: (prev) => ({ ...prev, tier: drillTier as TierId }) });
            setDrillTier(null);
          }}
          onClose={() => setDrillTier(null)}
        />
      ) : null}
    </AppShell>
  );
}

/** One tier, beside the screen — the rest of the page keeps its own scope. */
function TierDrawer({
  row,
  label,
  scoped,
  selectable,
  window: win,
  onScope,
  onClose,
}: {
  row: TierRow | null;
  label: string;
  scoped: boolean;
  selectable: boolean;
  window: string;
  onScope: () => void;
  onClose: () => void;
}) {
  const lines: { label: string; metric: Metric; format?: "inr" }[] = row
    ? [
        { label: "Sales", metric: fromObserved(row.sales) },
        { label: "Distinct buyers", metric: fromObserved(row.buyers) },
        { label: "Collected", metric: fromObserved(row.collected), format: "inr" },
        { label: "Average ticket", metric: fromNullable(row.avg_ticket), format: "inr" },
        { label: "Outstanding", metric: fromObserved(row.pending), format: "inr" },
        { label: "Payment rows", metric: fromObserved(row.rows_count) },
      ]
    : [];

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button
        aria-label="Close tier detail"
        onClick={onClose}
        className="flex-1 bg-background/60 backdrop-blur-[1px]"
      />
      <aside className="flex h-full w-full max-w-[440px] flex-col overflow-y-auto border-l border-border bg-card shadow-xl">
        <div className="sticky top-0 flex items-start gap-3 border-b border-border bg-card px-4 py-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">tier</div>
            <div className="truncate text-sm font-semibold">{label}</div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          <p className="text-[11px] text-muted-foreground">{win}</p>
          {row ? (
            <dl className="divide-y divide-border/60 text-[12px]">
              {lines.map((l) => (
                <div key={l.label} className="flex items-baseline justify-between py-1.5">
                  <dt className="text-muted-foreground">{l.label}</dt>
                  <dd className="font-mono tabular-nums">
                    {l.format ? (
                      <MetricValue metric={l.metric} format={l.format} />
                    ) : (
                      <MetricValue metric={l.metric} />
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-[12px] text-muted-foreground">{NO_DATA}</p>
          )}
          {selectable ? (
            <Button size="sm" variant="outline" disabled={scoped} onClick={onScope}>
              {scoped ? "This screen already shows this tier" : "Show this tier across the screen"}
            </Button>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              This tier is carried by the ledger but is not one of the tiers this screen can scope
              to.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

/**
 * Two independent counts of the same thing, side by side. TagMango enrolments
 * are the sale counter — timely, complete, coupon enrolments included. The
 * ledger is the money. While a day is settling the gap is ordinary lag; once
 * it has settled, a gap above 20% is a bookkeeping miss worth chasing.
 */
/**
 * Both directions, by name. Until 22 Sep 2026 only buyers missing from the
 * ledger were flagged, so a ledger buyer TagMango did not have went unnoticed.
 * The age of each source is printed beside the list: a day still being typed
 * up is not a disagreement.
 */
function DayNameByName({ data }: { data: DayReconciliation }) {
  const ledgerOnly = data.rows.filter((r) => r.side === "ledger_only");
  const tmOnly = data.rows.filter((r) => r.side === "tagmango_only");
  const time = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : NO_DATA;
  return (
    <section>
      <h2 className="mb-1 text-[12px] font-semibold">
        {data.date} — buyer by buyer, both sources
      </h2>
      <p className="mb-1 text-[11px] text-muted-foreground">
        TagMango last read {time(data.tagmangoLastRead)}; the accounts ledger was last imported{" "}
        {time(data.ledgerLastRead)} and reaches {data.ledgerLatestDay ?? NO_DATA}. Money is shown in
        rupees — a sale taken in another currency is converted at the rate stored on that payment,
        never added as-is.
      </p>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[12px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Buyer</th>
              <th className="px-3 py-1.5 text-left font-medium">In both?</th>
              <th className="px-3 py-1.5 text-right font-medium">TagMango</th>
              <th className="px-3 py-1.5 text-left font-medium">Offer code</th>
              <th className="px-3 py-1.5 text-right font-medium">Full price</th>
              <th className="px-3 py-1.5 text-right font-medium">Accounts ledger</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                  {NO_DATA}
                </td>
              </tr>
            ) : (
              data.rows.map((r) => (
                <tr key={`${r.side}-${r.email_key}`} className="border-t border-border/60">
                  <td className="px-3 py-1">
                    {r.person_name ?? r.email_key}
                    {r.person_name ? (
                      <span className="ml-1 text-[10px] text-muted-foreground">{r.email_key}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1">
                    {r.side === "both" ? (
                      <span className="text-muted-foreground">both</span>
                    ) : r.side === "ledger_only" ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        ledger only — TagMango does not have this buyer
                      </span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">
                        TagMango only — not yet typed into the ledger
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={fromNullable(toNum(r.tagmango_inr))} format="inr" />
                    {r.currency && r.currency !== "INR" ? (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        paid in {r.currency}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1 font-mono text-[11px]">{r.coupon_code ?? "—"}</td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={fromNullable(toNum(r.list_price_inr))} format="inr" />
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={fromNullable(toNum(r.ledger_inr))} format="inr" />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {count(ledgerOnly.length)} in the ledger only, {count(tmOnly.length)} in TagMango only.
        Full price is the standing list price before any code; where a code was used, the amount
        shown is the cash actually received, never an assumed price.
      </p>
    </section>
  );
}

function Reconciliation({
  rows,
  settlingDays,
  reviewDays,
}: {
  rows: ReconRow[];
  settlingDays: number;
  reviewDays: ReconRow[];
}) {
  return (
    <section>
      <h2 className="mb-1 text-[12px] font-semibold">Reconciliation — TagMango vs ledger</h2>
      {reviewDays.length > 0 ? (
        <div className="mb-1 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px]">
          <span className="font-semibold">
            {count(reviewDays.length)} settled day{reviewDays.length === 1 ? "" : "s"} diverge by
            more than 20%
          </span>{" "}
          — {reviewDays.map((r) => r.date).join(", ")}. These have stopped settling, so the gap is a
          bookkeeping miss for the accounts team, not lag.
        </div>
      ) : null}
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[12px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Business day</th>
              <th className="px-3 py-1.5 text-right font-medium">Enrolments (TagMango)</th>
              <th className="px-3 py-1.5 text-right font-medium">New sales (ledger)</th>
              <th className="px-3 py-1.5 text-right font-medium">Collected</th>
              <th className="px-3 py-1.5 text-right font-medium">Divergence</th>
              <th className="px-3 py-1.5 text-left font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                  {NO_DATA}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.date} className="border-t border-border/60 hover:bg-muted/40">
                  <td className="px-3 py-1 font-mono tabular-nums">{r.date}</td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={fromNullable(toNum(r.tm_sales))} />
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={fromNullable(toNum(r.ledger_sales))} />
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={fromNullable(toNum(r.collected))} format="inr" />
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={fromNullable(toNum(r.divergence_pct))} format="decimal" />
                  </td>
                  <td className="px-3 py-1">
                    {r.settling ? (
                      <span className="text-amber-600 dark:text-amber-400">settling</span>
                    ) : r.review ? (
                      <span className="text-destructive">review</span>
                    ) : (
                      <span className="text-muted-foreground">settled</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {count(settlingDays)} day{settlingDays === 1 ? "" : "s"} in this window are still settling:
        a day settles once three days have passed or the two counts agree within 20%. Divergence is
        the ledger count against the TagMango count, in percent.
      </p>
    </section>
  );
}

/**
 * A window ending inside the maturation horizon is not final. Nearly a quarter
 * of sales arrive more than a week after registration, so yesterday's count
 * must never look as settled as March's.
 */
function MaturationBanner({ until }: { until: string }) {
  const days = Math.round((Date.now() - new Date(`${until}T00:00:00Z`).getTime()) / 86400000);
  if (days > 14) return null;
  return (
    <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px]">
      <span className="font-semibold">This window is still maturing.</span> Its end is {days} day
      {days === 1 ? "" : "s"} old. A meaningful share of sales arrives more than a week after
      someone registers, so every sales and money figure below for this window is a floor and will
      rise.
    </div>
  );
}

/**
 * Monthly only, and by calendar lag from the most recent webinar business day:
 * the ledger records a date, not a timestamp, so a true in-webinar bucket is
 * not computable and is not offered.
 */
function SaleTimingFigure({ since, until, tier }: { since: string; until: string; tier: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["sale-timing", since, until, tier],
    queryFn: () => getSaleTiming({ data: { since, until, tier } }),
  });

  const rows = data?.rows ?? [];
  const periods = Array.from(new Set(rows.map((r) => r.period))).sort();
  const buckets = ["same_day", "d1_7", "d8_plus", "no_session"] as const;
  const chartRows = periods.map((p) => {
    const out: Record<string, string | number> = { period: p };
    for (const b of buckets) {
      out[b] = rows
        .filter((r) => r.period === p && r.bucket === b)
        .reduce((a, r) => a + (Number(r.sales) || 0), 0);
    }
    return out;
  });
  const noSession = rows
    .filter((r) => r.bucket === "no_session")
    .reduce((a, r) => a + (Number(r.sales) || 0), 0);
  const totalSales = rows.reduce((a, r) => a + (Number(r.sales) || 0), 0);

  const colours = [
    "var(--primary)",
    "var(--positive)",
    "var(--muted-foreground)",
    "var(--warning)",
  ];

  return (
    <Figure
      id="sales-timing"
      title="When the sale lands · monthly only"
      note="calendar lag from the most recent webinar business day"
      n={`${count(totalSales)} sales across ${count(periods.length)} month${periods.length === 1 ? "" : "s"}`}
      window={`${since} → ${until}`}
      excluded={
        noSession > 0
          ? `${count(noSession)} sales had no webinar on or before their business date and sit in their own bucket — they are shown, never folded into another`
          : "nothing excluded"
      }
      chart={
        chartRows.length === 0 ? undefined : (
          <div className="h-[260px] px-2 py-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartRows} margin={{ top: 16, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="period" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  width={56}
                  domain={[0, "auto"]}
                  tickFormatter={(v: number) => count(v)}
                />
                <Tooltip
                  contentStyle={{
                    background: "var(--card)",
                    border: "1px solid var(--border)",
                    fontSize: 12,
                  }}
                  formatter={(v: number, k: string) => [count(v), BUCKET_LABEL[k as never]]}
                />
                {buckets.map((b, i) => (
                  <Bar key={b} dataKey={b} stackId="a" fill={colours[i]}>
                    <LabelList
                      dataKey={b}
                      position="inside"
                      fontSize={10}
                      fill="var(--background)"
                    />
                  </Bar>
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )
      }
      table={
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Month</th>
                {buckets.map((b) => (
                  <th key={b} className="px-2 py-1.5 text-right font-medium">
                    {BUCKET_LABEL[b]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              ) : periods.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">
                    {NO_DATA}
                  </td>
                </tr>
              ) : (
                periods.map((p) => (
                  <tr key={p} className="border-t border-border/60">
                    <td className="px-3 py-1 font-mono tabular-nums">{p}</td>
                    {buckets.map((b) => {
                      const n = rows
                        .filter((r) => r.period === p && r.bucket === b)
                        .reduce((a, r) => a + (Number(r.sales) || 0), 0);
                      return (
                        <td key={b} className="px-2 py-1 text-right font-mono tabular-nums">
                          <MetricValue metric={fromObserved(n)} />
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      }
    />
  );
}

/**
 * What was actually charged. A sale price is never assumed: offers recur and
 * overseas buyers pay a different amount, so cost per sale and return are read
 * against the cash actually received, converted to rupees at the rate stored
 * on the payment.
 */
function PriceMix({ since, until }: { since: string; until: string }) {
  const { data } = useQuery({
    queryKey: ["price-mix", since, until],
    queryFn: () => getPriceMix({ data: { since, until } }),
    staleTime: 5 * 60_000,
  });
  const daily = data?.daily ?? [];
  const bySource = data?.bySource ?? [];
  const weeks = data?.realisedWeeks ?? [];
  const listPrice = data?.listPrice ?? null;
  if (daily.length === 0) return null;

  const sales = daily.reduce((a, d) => a + Number(d.sales ?? 0), 0);
  const cash = daily.reduce((a, d) => a + Number(d.cash_received ?? 0), 0);
  const discounted = daily.reduce((a, d) => a + Number(d.discounted_sales ?? 0), 0);
  const given = daily.reduce((a, d) => a + Number(d.discount_given ?? 0), 0);
  const overseas = daily.reduce((a, d) => a + Number(d.overseas_sales ?? 0), 0);

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-[12px] font-semibold">Full price against discounted</h2>
        <p className="text-[11px] text-muted-foreground">
          What buyers were actually charged in this window, from the course platform's own payment
          records. {formatInt(sales - discounted)} of {formatInt(sales)} sales were at the full
          price{listPrice === null ? "" : ` of ${formatINR(listPrice)}`}, {formatInt(discounted)}{" "}
          were discounted, {formatInt(overseas)} were paid from overseas and converted to rupees at
          the rate stored on the payment, {formatINR(given)} was given away, and the real average
          sale was {sales > 0 ? formatINR(cash / sales) : "no data"}. No figure on this screen uses
          an assumed price.
        </p>
      </div>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[12px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left">Day</th>
              <th className="px-2 py-1 text-right">Sales</th>
              <th className="px-2 py-1 text-right">Full price</th>
              <th className="px-2 py-1 text-right">Discounted</th>
              <th className="px-2 py-1 text-right">Overseas</th>
              <th className="px-2 py-1 text-right">Cash</th>
              <th className="px-2 py-1 text-right">Average sale</th>
              <th className="px-2 py-1 text-right">Discount given</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {daily.map((d) => (
              <tr key={d.business_date}>
                <td className="px-2 py-1">{d.business_date}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatInt(d.sales)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatInt(d.full_price_sales)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatInt(d.discounted_sales)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatInt(d.overseas_sales)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatINR(d.cash_received)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatINR(d.avg_sale_value)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{formatINR(d.discount_given)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {bySource.length > 0 ? (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-[12px]">
            <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left">Source</th>
                <th className="px-2 py-1 text-right">Sales</th>
                <th className="px-2 py-1 text-right">Full price</th>
                <th className="px-2 py-1 text-right">Discounted</th>
                <th className="px-2 py-1 text-right">Overseas</th>
                <th className="px-2 py-1 text-right">Average sale</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {bySource.map((r) => (
                <tr key={r.source}>
                  <td className="px-2 py-1">{r.source}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatInt(r.sales)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatInt(r.full_price_sales)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatInt(r.discounted_sales)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatInt(r.overseas_sales)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{formatINR(r.avg_sale_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
