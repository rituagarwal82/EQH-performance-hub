import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { MetricValue } from "@/components/MetricValue";
import { RouteError } from "@/components/UiError";
import { count } from "@/lib/counts";
import {
  COHORT_COVERAGE_GATE,
  getCohortReturn,
  type CohortRow,
} from "@/lib/cohorts.functions";
import { measured, partial, toNum, unmeasured, type Metric } from "@/lib/metric";

const cohortQuery = () =>
  queryOptions({
    queryKey: ["cohort-return"],
    queryFn: () => getCohortReturn({ data: {} }),
  });

export const Route = createFileRoute("/_authenticated/cohorts")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(cohortQuery());
  },
  head: () => ({
    meta: [
      { title: "Cohort return — EQH Performance Engine" },
      {
        name: "description",
        content:
          "What buyers acquired in each month have paid back since, across every tier, against that month's Meta ad spend — front end and back end separated, with the month each group crossed breakeven.",
      },
      { property: "og:title", content: "Cohort return — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "Back-end return by acquisition month: cumulative cash per buyer and per rupee of ad spend at 30, 90, 180 and 365 days.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CohortsPage,
  errorComponent: ({ error, reset }) => (
    <RouteError
      error={error}
      reset={reset}
      subject="the cohort return view"
      where="src/routes/_authenticated/cohorts.tsx"
    />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

const MONTH = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * A ratio is shown only when the spend basis exists AND enough of the cohort's
 * buyers could be matched to a lead. The SX era's spend total is known but its
 * campaign detail is not, so those months are marked partial, never final.
 */
function ratio(r: CohortRow, v: number | string | null): Metric {
  const value = toNum(v);
  const cov = toNum(r.coverage_pct);
  if (r.spend_basis === "none") return unmeasured("no ad spend on record for this month");
  if (cov === null || cov < COHORT_COVERAGE_GATE) {
    return unmeasured("too few of this month's buyers could be matched to a lead");
  }
  if (value === null) return unmeasured("not enough history yet");
  if (r.spend_basis === "sx_regime") {
    return partial(
      value,
      "closed SX era — the month's spend total is known but its campaign detail is not, so this is a floor",
    );
  }
  if (r.maturing) {
    return partial(value, "this group is still buying — the figure will rise");
  }
  return measured(value);
}

function money(v: number | string | null): Metric {
  const n = toNum(v);
  return n === null ? unmeasured("no cash on record") : measured(n);
}

/**
 * TWO BLOCKS, NEVER MIXED.
 *
 * "all"  — every buyer of the month, and every rupee those same people paid.
 * "meta" — only buyers whose lead traces to a Meta ad, and only their money.
 *
 * The old single table counted all buyers but only Meta money, so cash per
 * buyer read far lower than it really was.
 */
function CohortTable({ rows, scope }: { rows: CohortRow[]; scope: "all" | "meta" }) {
  const meta = scope === "meta";
  return (
    <div className="overflow-x-auto rounded border border-border">
      <table className="w-full text-[12px]">
        <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-1.5 text-left font-medium">Acquired</th>
            <th className="px-3 py-1.5 text-right font-medium">Buyers</th>
            {meta ? (
              <th className="px-3 py-1.5 text-right font-medium">Matched to a lead</th>
            ) : null}
            <th className="px-3 py-1.5 text-right font-medium">Ad spend</th>
            <th className="px-3 py-1.5 text-right font-medium">Front end (life)</th>
            <th className="px-3 py-1.5 text-right font-medium">Later cash (life)</th>
            <th className="px-3 py-1.5 text-right font-medium">Per buyer (life)</th>
            <th className="px-3 py-1.5 text-right font-medium">Per ₹1 · 90d</th>
            <th className="px-3 py-1.5 text-right font-medium">Per ₹1 · to date</th>
            {meta ? (
              <th className="px-3 py-1.5 text-right font-medium">Breakeven month</th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={meta ? 10 : 8} className="px-2 py-6 text-center text-muted-foreground">
                No cohorts in range.
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const cov = toNum(r.coverage_pct);
              const be = toNum(r.breakeven_month);
              const buyers = meta ? toNum(r.paid_buyers) : toNum(r.buyers);
              const front = meta ? r.front_life : r.front_life_all;
              const back = meta ? r.back_life : r.back_life_all;
              const perBuyer = meta ? r.per_buyer_life_paid : r.per_buyer_life_all;
              const d90 = meta ? r.roas_d90 : r.roas_d90_all;
              const life = meta ? r.roas_life : r.roas_life_all;
              return (
                <tr key={r.cohort_month} className="border-t border-border/60 hover:bg-muted/40">
                  <td className="px-3 py-1 font-medium">
                    {MONTH(r.cohort_month)}
                    {r.maturing ? (
                      <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                        still maturing
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    {count(buyers ?? 0)}
                  </td>
                  {meta ? (
                    <td className="px-3 py-1 text-right font-mono tabular-nums text-muted-foreground">
                      {cov === null ? "—" : `${cov}%`}
                    </td>
                  ) : null}
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue
                      metric={
                        r.spend_basis === "none"
                          ? unmeasured("no ad spend on record for this month")
                          : money(r.spend)
                      }
                      format="inr"
                    />
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={money(front)} format="inr" />
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={money(back)} format="inr" emphasis />
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={money(perBuyer)} format="inr" />
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={ratio(r, d90)} format="ratio" />
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={ratio(r, life)} format="ratio" emphasis />
                  </td>
                  {meta ? (
                    <td className="px-3 py-1 text-right font-mono tabular-nums">
                      {r.spend_basis === "none" ? "—" : be ? `month ${be}` : "not yet"}
                    </td>
                  ) : null}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function CohortsPage() {
  const { data } = useSuspenseQuery(cohortQuery());
  const rows = data.rows;

  const closed = rows.filter((r) => !r.maturing && r.spend_basis !== "none");
  const projectionAllowed = closed.length >= 3;

  const headline =
    [...rows]
      .reverse()
      .find((r) => r.spend_basis !== "none" && toNum(r.roas_d90) !== null) ?? null;
  const headlineRatio = headline ? toNum(headline.roas_life) : null;
  const headlineBe = headline ? toNum(headline.breakeven_month) : null;

  return (
    <AppShell>
      <div className="space-y-5 px-6 py-4">
        <header className="space-y-1">
          <h1 className="text-base font-semibold tracking-tight">
            Return by month of first purchase
          </h1>
          <p className="max-w-3xl text-[12px] text-muted-foreground">
            Every buyer is grouped by the month of their first L1 purchase, then all the money that
            same person has spent since — on any product, at any tier — is followed forward and set
            against that month&apos;s Meta ad spend. Cash is gross as received from the student,
            GST included, the same basis as every other money figure in this engine: no fees,
            commission, delivery cost or refunds.
          </p>
        </header>

        {data.error ? (
          <p className="rounded border border-border bg-muted/40 px-3 py-2 text-[12px]">
            The cohort read did not answer. Nothing below is a measured fact right now.
          </p>
        ) : null}

        {headline && headlineRatio !== null ? (
          <p className="rounded border border-border bg-muted/30 px-3 py-2 text-[12px]">
            Buyers acquired in <span className="font-medium">{MONTH(headline.cohort_month)}</span>{" "}
            through Meta ads have returned{" "}
            <span className="font-medium">₹{headlineRatio.toFixed(2)}</span> per ₹1 of ad spend so
            far
            {headlineBe
              ? `; they crossed breakeven in month ${headlineBe}.`
              : "; they have not yet crossed breakeven."}
          </p>
        ) : null}

        <section className="space-y-1">
          <h2 className="text-[13px] font-semibold">All new L1 buyers</h2>
          <p className="text-[11px] text-muted-foreground">
            Everyone who bought the L1 for the first time that month, from any source, and every
            rupee those same people have paid since. The spend column is Meta spend only, so the
            per-₹1 columns here answer &ldquo;what did the whole month return against the ad
            money&rdquo;, not what the ads alone returned.
          </p>
          <CohortTable rows={rows} scope="all" />
        </section>

        <section className="space-y-1">
          <h2 className="text-[13px] font-semibold">L1 buyers from Meta ads</h2>
          <p className="text-[11px] text-muted-foreground">
            Only buyers whose lead traces to a Meta ad, and only their money, against the same Meta
            spend — buyers and cash from the same people, so this is the ad-performance figure.
          </p>
          <CohortTable rows={rows} scope="meta" />
        </section>

        <div className="space-y-1 text-[11px] text-muted-foreground">
          <p>
            Months before August 2026 sit in the closed SX era: the spend total is on record but the
            campaign detail is not, so their ratios are shown as a floor, never as final.
          </p>
          <p>
            {projectionAllowed
              ? `${count(closed.length)} cohorts are old enough to have finished their first year.`
              : `No forward projection is offered: ${count(
                  closed.length,
                )} of the 3 completed cohort curves needed for that exist.`}
          </p>
          <p>Cash is counted on the date the accounts team recorded it.</p>
        </div>
      </div>
    </AppShell>
  );
}
