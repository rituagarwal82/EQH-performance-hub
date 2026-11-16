import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { PromotionNote } from "@/components/PromotionNote";
import { RouteError } from "@/components/UiError";
import {
  formatINR,
  formatInt,
  formatPercent,
  formatRatio,
  MONTH_NAMES,
  NO_DATA,
  toNumber,
} from "@/lib/format";
import {
  getAgencyReport,
  type AgencyCohortRow,
  type AgencyMonthRow,
} from "@/lib/agencies.functions";

const reportQuery = (month?: string) =>
  queryOptions({
    queryKey: ["agency-report", month ?? "latest"],
    queryFn: () => getAgencyReport({ data: month ? { month } : {} }),
  });

export const Route = createFileRoute("/_authenticated/agencies")({
  validateSearch: (search: Record<string, unknown>) => ({
    month: typeof search["month"] === "string" ? (search["month"] as string) : undefined,
  }),
  loaderDeps: ({ search }) => ({ month: search.month }),
  loader: async ({ context, deps }) => {
    await context.queryClient.ensureQueryData(reportQuery(deps.month));
  },
  head: () => ({
    meta: [
      { title: "Agencies — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Every agency and source judged across the same funnel: spend, registrations, show-up, L1 sales, front-end return and what those buyers spent later.",
      },
      { property: "og:title", content: "Agencies — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "Spend to registrations to show-up to L1 sales, one card per agency, with what each buyer spent later.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AgenciesPage,
  errorComponent: ({ error, reset }) => (
    <RouteError
      error={error}
      reset={reset}
      subject="the agencies view"
      where="src/routes/_authenticated/agencies.tsx"
    />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

const SD_META = "Sabhi Digital – Meta ads";
const SD_GOOGLE = "Sabhi Digital – Google Ads";
const RJ = "Rajdeep (in-house) – Meta ads";
const PRM = "Parami – Meta ads";

const PAST = ["ScaleX (agency, closed)", "Tushar (agency, closed)", "Vlad (agency, closed)"];

const CARDS: { title: string; lines: string[] }[] = [
  { title: "Sabhi Digital", lines: [SD_META, SD_GOOGLE] },
  { title: "Rajdeep (in-house)", lines: [RJ] },
  { title: "Parami", lines: [PRM] },
];

const LINE_LABEL: Record<string, string> = {
  [SD_META]: "Meta ads",
  [SD_GOOGLE]: "Google Ads",
  [RJ]: "Meta ads",
  [PRM]: "Meta ads",
};

const COLLAB_CAPTION =
  "free collaboration — not a sale. These people joined free through another coach, so a sale appears only if that person later paid.";

function n(v: number | string | null | undefined): number {
  return toNumber(v) ?? 0;
}

function monthLabel(month: string) {
  const [y, m] = month.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

/** A number, or the plain reason there isn't one. Never a zero standing in. */
function Held({ reason }: { reason: string }) {
  return <span className="text-[11px] italic text-muted-foreground">{reason}</span>;
}

function Row({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string | undefined;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-border/50 py-1 first:border-t-0">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="text-right font-mono text-[12px] tabular-nums">
        {value}
        {hint ? <span className="ml-2 font-sans text-[11px] text-muted-foreground">{hint}</span> : null}
      </span>
    </div>
  );
}

/**
 * The stored reason is written for engineers ("held 2026-09-07: SD symmetry
 * gate…"). The owner reads plain sentences, so the internal text never reaches
 * the screen.
 */
function ratioReason(r: AgencyMonthRow): string {
  if (!r.spend_known) {
    return r.channel.includes("Google")
      ? "Google spend isn't connected, so no cost can be shown"
      : "this source has no ad spend connected, so no cost can be shown";
  }
  return "cost figures switch on once this team's nightly checks pass two clean nights in a row";
}

function FunnelLines({ r }: { r: AgencyMonthRow }) {
  const ok = r.ratios_ok;
  const reason = ratioReason(r);
  return (
    <div className="mt-1">
      <Row
        label="Spend"
        value={r.spend_known ? formatINR(r.spend) : <Held reason={reason} />}
        hint={
          r.spend_known && n(r.retarget_spend) > 0
            ? `of which ${formatINR(r.retarget_spend)} retargeting / brand`
            : undefined
        }
      />
      <Row
        label="Registrations"
        value={formatInt(r.registrations)}
        hint={
          ok && r.cost_per_registration !== null
            ? `${formatINR(r.cost_per_registration)} each`
            : undefined
        }
      />
      <Row
        label="Showed up"
        value={`${formatInt(r.show_ups)} · ${formatPercent(
          n(r.registrations) > 0 ? (100 * n(r.show_ups)) / n(r.registrations) : null,
        )}`}
        hint={ok && r.cost_per_show_up !== null ? `${formatINR(r.cost_per_show_up)} each` : undefined}
      />
      <Row
        label="L1 sales"
        value={`${formatInt(r.sales)} · ${formatInt(r.fully_paid)} fully paid`}
        hint={ok && r.cost_per_sale !== null ? `${formatINR(r.cost_per_sale)} per sale` : undefined}
      />
      <Row
        label="Front-end return"
        value={
          ok && r.front_end_return !== null ? (
            formatRatio(toNumber(r.front_end_return))
          ) : (
            <Held reason={reason} />
          )
        }
        hint={`${formatINR(r.cash)} L1 cash`}
      />

      <Row
        label="How they bought"
        value={`${formatInt(r.webinar_sales)} on webinar day · ${formatInt(
          r.followup_sales,
        )} within 30 days · ${formatInt(r.no_attendance_sales)} no attendance found`}
      />
      <Row
        label="Worth later"
        value={
          r.later_cash_per_buyer === null || n(r.buyers) === 0 ? (
            <Held reason="no buyers in this month" />
          ) : (
            `${formatINR(r.later_cash_per_buyer)} per buyer`
          )
        }
        hint={`${formatInt(r.diamond_buyers)} Diamond buyers${
          r.window_open ? " · still counting" : ""
        }`}
      />

      {/* Parami's ads carry no tracking parameters in their links, so a lead
          can be traced to Parami but not to the ad that brought it. */}
      {r.channel === PRM ? (
        <p className="border-warning/40 bg-warning/10 text-warning mt-2 rounded border px-2 py-1.5 text-[12px] leading-relaxed">
          Parami's links carry no tracking details, so their team totals here are right but we
          cannot tell which of their ads brought which lead. Ad-by-ad comparison starts once they
          add tracking to their links.
        </p>
      ) : null}
    </div>
  );
}

function CohortLines({ c }: { c: AgencyCohortRow }) {
  return (
    <div className="mt-1">
      <Row label="Registrations" value={formatInt(c.registrations)} />
      <Row
        label="Showed up"
        value={`${formatInt(c.show_ups)} · ${formatPercent(toNumber(c.show_up_pct))}`}
      />
      <Row label="Became L1 buyers" value={formatInt(c.buyers)} />
      <Row
        label="How they bought"
        value={`${formatInt(c.webinar_sales)} on webinar day · ${formatInt(
          c.followup_sales,
        )} within 30 days · ${formatInt(c.no_attendance_sales)} no attendance found`}
      />
      <Row
        label="Worth later (90 days)"
        value={
          c.too_few ? (
            <Held reason="too few buyers to judge" />
          ) : c.later_cash_per_buyer === null ? (
            <Held reason="no buyers in this group" />
          ) : (
            `${formatINR(c.later_cash_per_buyer)} per buyer`
          )
        }
        hint={`${formatInt(c.diamond_buyers)} Diamond buyers${
          c.window_open ? " · still counting" : ""
        }`}
      />
    </div>
  );
}

/** Up to three strictly numeric comparisons. No causes, no advice. */
function standOut(rows: AgencyMonthRow[]): string[] {
  const live = rows.filter(
    (r) => [SD_META, SD_GOOGLE, RJ, PRM].includes(r.channel) && n(r.registrations) > 0,
  );
  const out: string[] = [];
  const withCost = live.filter((r) => r.ratios_ok && r.cost_per_registration !== null);
  if (withCost.length >= 2) {
    const sorted = [...withCost].sort(
      (a, b) => n(a.cost_per_registration) - n(b.cost_per_registration),
    );
    const lo = sorted[0]!;
    const hi = sorted[sorted.length - 1]!;
    out.push(
      `${lo.channel} paid ${formatINR(lo.cost_per_registration)} per registration against ${formatINR(
        hi.cost_per_registration,
      )} for ${hi.channel}.`,
    );
  }
  if (live.length >= 2) {
    const byShow = [...live].sort(
      (a, b) => n(b.show_ups) / n(b.registrations) - n(a.show_ups) / n(a.registrations),
    );
    const top = byShow[0]!;
    const bottom = byShow[byShow.length - 1]!;
    out.push(
      `${formatPercent((100 * n(top.show_ups)) / n(top.registrations))} of ${top.channel} registrations showed up, against ${formatPercent(
        (100 * n(bottom.show_ups)) / n(bottom.registrations),
      )} for ${bottom.channel}.`,
    );
  }
  const withSales = live.filter((r) => n(r.sales) > 0);
  if (withSales.length >= 2) {
    const bySales = [...withSales].sort((a, b) => n(b.sales) - n(a.sales));
    const first = bySales[0]!;
    const second = bySales[1]!;
    out.push(
      `${first.channel} produced ${formatInt(first.sales)} L1 sales this month against ${formatInt(
        second.sales,
      )} for ${second.channel}.`,
    );
  }
  return out.slice(0, 3);
}

function AgenciesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/agencies" });
  const { data } = useSuspenseQuery(reportQuery(search.month));
  const [view, setView] = useState<"activity" | "cohort">("activity");

  const byChannel = new Map(data.activity.map((r) => [r.channel, r]));
  const cohortByChannel = new Map(data.cohort.map((r) => [r.channel, r]));

  const cards = CARDS.filter((c) =>
    c.lines.some((line) => {
      const r = byChannel.get(line);
      const co = cohortByChannel.get(line);
      return (
        (r && (n(r.registrations) > 0 || n(r.sales) > 0 || n(r.spend) > 0)) ||
        (co && n(co.registrations) > 0)
      );
    }),
  );

  const namedLines = new Set([...CARDS.flatMap((c) => c.lines), ...PAST]);
  const others = data.activity.filter((r) => !namedLines.has(r.channel));
  const past = PAST.map((p) => byChannel.get(p)).filter(Boolean) as AgencyMonthRow[];
  const highlights = standOut(data.activity);

  const totalSales = data.activity.reduce((a, r) => a + n(r.sales), 0);

  return (
    <AppShell>
      <div className="space-y-4 px-6 py-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-base font-semibold tracking-tight">Agencies</h1>
            <p className="max-w-3xl text-[12px] text-muted-foreground">
              Each agency and source across the same funnel, for one month at a time. L1 sales only;
              money from other products appears solely as what these buyers spent later.
            </p>
          </div>
          <label className="text-[12px] text-muted-foreground">
            Month{" "}
            <select
              value={data.month}
              onChange={(e) => void navigate({ search: { month: e.target.value } })}
              className="rounded border border-border bg-background px-2 py-1 text-[12px] text-foreground"
            >
              {data.months.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </select>
          </label>
        </header>

        <div className="space-y-1">
          <div className="inline-flex overflow-hidden rounded border border-border text-[12px]">
            {(
              [
                ["activity", "This month's activity"],
                ["cohort", "Quality of this month's registrations"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`px-3 py-1 ${
                  view === key ? "bg-muted font-semibold text-foreground" : "text-muted-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {view === "activity"
              ? "Everything that happened inside this calendar month — spend paid, people who registered, and sales taken — even if the buyer registered earlier."
              : "Only the people who first registered in this month, followed forward: how many showed up, how many bought, and what they have spent since."}
          </p>
        </div>

        {data.error ? (
          <p className="rounded border border-border bg-muted/40 px-3 py-2 text-[12px]">
            The agency report did not answer. Nothing below is a measured fact right now.
          </p>
        ) : null}

        <PromotionNote
          since={`${data.month}-01`}
          until={new Date(
            Date.UTC(Number(data.month.slice(0, 4)), Number(data.month.slice(5, 7)), 0),
          )
            .toISOString()
            .slice(0, 10)}
        />

        {highlights.length > 0 && view === "activity" ? (
          <section className="rounded border border-border bg-muted/30 px-3 py-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              What stands out
            </h2>
            <ul className="mt-1 space-y-0.5 text-[12px]">
              {highlights.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-2">
          {cards.map((card) => (
            <section key={card.title} className="rounded border border-border bg-card px-3 py-2">
              <h2 className="text-[13px] font-semibold">{card.title}</h2>
              {card.lines.map((line) => {
                const r = byChannel.get(line);
                const c = cohortByChannel.get(line);
                if (!r && !c) return null;
                return (
                  <div key={line} className="mt-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {LINE_LABEL[line] ?? line}
                    </div>
                    {view === "activity" ? (
                      r ? (
                        <FunnelLines r={r} />
                      ) : (
                        <Held reason="nothing recorded for this month" />
                      )
                    ) : c ? (
                      <CohortLines c={c} />
                    ) : (
                      <Held reason="nobody registered through this line in this month" />
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>

        {past.length > 0 ? (
          <details className="rounded border border-border bg-card px-3 py-2">
            <summary className="cursor-pointer text-[13px] font-semibold">Past agencies</summary>
            <div className="grid gap-3 pt-2 lg:grid-cols-2">
              {past.map((r) => (
                <div key={r.channel}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {r.channel}
                  </div>
                  <FunnelLines r={r} />
                </div>
              ))}
            </div>
          </details>
        ) : null}

        <section className="space-y-1">
          <h2 className="text-[13px] font-semibold">Other sources</h2>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-[12px]">
              <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Source</th>
                  <th className="px-3 py-1.5 text-right font-medium">Registrations</th>
                  <th className="px-3 py-1.5 text-right font-medium">Showed up</th>
                  <th className="px-3 py-1.5 text-right font-medium">L1 sales</th>
                  <th className="px-3 py-1.5 text-right font-medium">Fully paid</th>
                  <th className="px-3 py-1.5 text-right font-medium">L1 cash</th>
                </tr>
              </thead>
              <tbody>
                {others.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-5 text-center text-muted-foreground">
                      Nothing else recorded in this month.
                    </td>
                  </tr>
                ) : (
                  others.map((r) => (
                    <tr key={r.channel} className="border-t border-border/60 hover:bg-muted/40">
                      <td className="px-3 py-1">
                        {r.channel}
                        {r.channel.startsWith("Collaboration") ? (
                          <div className="text-[10px] text-muted-foreground">{COLLAB_CAPTION}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        {formatInt(r.registrations)}
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        {formatInt(r.show_ups)}
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        {formatInt(r.sales)}
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        {formatInt(r.fully_paid)}
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        {formatINR(r.cash)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot className="border-t border-border bg-muted/40 font-semibold">
                <tr>
                  <td className="px-3 py-1.5">All sources this month</td>
                  <td />
                  <td />
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                    {formatInt(totalSales)}
                  </td>
                  <td colSpan={2} className="px-3 py-1.5 text-right text-[11px] font-normal">
                    {data.ledgerSales === null
                      ? NO_DATA
                      : data.ledgerSales === totalSales
                        ? `matches the accounts ledger (${formatInt(data.ledgerSales)} L1 sales)`
                        : `the accounts ledger records ${formatInt(data.ledgerSales)} L1 sales for this month`}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <p className="text-[11px] text-muted-foreground">
          <Link to="/cohorts" className="underline underline-offset-2">
            Return by month of first purchase
          </Link>{" "}
          — what buyers have paid back since, month by month.
        </p>
      </div>
    </AppShell>
  );
}
