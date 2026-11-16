import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { RouteError } from "@/components/UiError";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { AccountsTable } from "@/components/AccountsTable";
import { AnalystBrief, useBriefTeaser } from "@/components/AnalystBrief";
import { AppShell } from "@/components/AppShell";
import { PromotionNote } from "@/components/PromotionNote";
import { ChecksCouldNotRun, EngineUnreadable, SectionUnavailable } from "@/components/DataOutage";
import { DataMenu } from "@/components/DataMenu";

import { Disclosure } from "@/components/Disclosure";
import { useDensityMode } from "@/components/DensityProvider";
import { Kpi } from "@/components/Kpi";
import { Provenance } from "@/components/Provenance";
import { ProofLine } from "@/components/VerifiedMark";
import { CoverageLine } from "@/components/CoverageLine";
import { CoverageNotice } from "@/components/CoverageNotice";
import { RegimeNotice } from "@/components/RegimeNotice";
import { regimeCrossings } from "@/lib/regime";

import { FeedCautionPanel, WithheldPanel, WorstFeedChip } from "@/components/FeedHealthStrip";
import { cautionFeeds, withholdingFeeds } from "@/lib/feed-health";
import { MetricValue } from "@/components/MetricValue";
import { RangeBar } from "@/components/RangeBar";
import {
  ScalingWatchPanel,
  scalingDemandsAttention,
  useScalingWatch,
} from "@/components/ScalingWatch";
import {
  AllClear,
  AttentionCards,
  HoldingLine,
  NotMeasuredLine,
  TokenExpiryNotice,
  VerdictCoverageLine,
  VerdictSentence,
} from "@/components/VerdictSurface";

import { accountView, totals as computeTotals } from "@/lib/account-view";
import { blendedCashRatio, paidFrontEndRoas, resolveCeiling } from "@/lib/breakeven";
import { FilterScope } from "@/components/FilterScope";
import { getAgencyRatioFlags } from "@/lib/agency.functions";
import { triggerSync } from "@/lib/dashboard.functions";
import { count, inrText } from "@/lib/counts";
import { NO_DATA } from "@/lib/format";
import { divideMetrics, measured, type Metric, toNum, unmeasured } from "@/lib/metric";
import { getAllTierCash, type TierCashRow } from "@/lib/cohorts.functions";
import { overviewQuery } from "@/lib/overview-query";
import { coverageDeltaGuard } from "@/lib/coverage-shift";
import { validateRangeSearch } from "@/lib/range-search";
import { verdictQuery } from "@/lib/verdict-query";
import { BRIEF_ROWS } from "@/lib/view-prefs";

export const Route = createFileRoute("/_authenticated/")({
  validateSearch: validateRangeSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(overviewQuery(deps)),
      context.queryClient.ensureQueryData(verdictQuery()),
    ]),
  head: () => ({
    meta: [
      { title: "Today — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Meta Ads spend, registrations and measured cost per registration for Energy Queens Hub, with an explicit measurement-coverage line.",
      },
      { property: "og:title", content: "Today — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "Meta spend, registrations and measurement coverage across every Energy Queens Hub ad account.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TodayPage,
    errorComponent: ({ error, reset }) => (
    <RouteError error={error} reset={reset} subject="today's figures" where="src/routes/index.tsx" />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

function TodayPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/" });
  const { data: overview } = useSuspenseQuery(overviewQuery(search));
  const { data: verdictData } = useSuspenseQuery(verdictQuery());
  const { brief: briefMode } = useDensityMode();
  // The window that EXISTS, never the one that was asked for.
  const range = overview.range;
  const coverage = overview.coverage;
  const rangeDays = coverage?.clippedDays;
  const runSync = useServerFn(triggerSync);
  const [seeAllAccounts, setSeeAllAccounts] = useState(false);

  // Deny by default: until the rule says otherwise, no team gets ratios.
  const ratioFlags = useQuery({
    queryKey: ["agency-ratio-flags"],
    queryFn: () => getAgencyRatioFlags(),
  });
  const ratiosComputable = ratioFlags.data?.codes ?? [];
  const ratiosValidFrom = ratioFlags.data?.validFrom ?? {};
  // The ledger takes no team argument, so blended cash ÷ team spend divides one
  // universe by another whatever a coverage flag says. These two figures are
  // therefore refused under ANY team filter, permanently — not conditionally.
  const teamRatios = !search.agency;


  const scoped = overview.accounts.filter((a) => !search.agency || a.agency_code === search.agency);
  const priorScoped = overview.priorAccounts.filter(
    (a) => !search.agency || a.agency_code === search.agency,
  );

  const views = scoped.map((row) => accountView(row, { rangeDays }));
  const priorViews = priorScoped.map((row) => accountView(row, { rangeDays }));
  const t = computeTotals(views);
  const priorT = computeTotals(priorViews);

  const active = views.filter((v) => (v.spend.value ?? -1) > 0);
  const activeRanked = active.slice().sort((a, b) => (b.spend.value ?? -1) - (a.spend.value ?? -1));
  const shownAccounts =
    briefMode && !seeAllAccounts ? activeRanked.slice(0, BRIEF_ROWS) : activeRanked;

  // Break-even ceiling, now fed by ledger-measured ticket sizes and ascension —
  // still labelled modelled, and never rendered apart from real ROAS.
  const resolved = resolveCeiling(overview.breakEven, overview.ascension);
  const ceilingMetric = resolved.ceiling;
  const headroom = divideMetrics(t.costPerMeasuredRegistration, ceilingMetric);
  // "The ledger read failed" and "the ledger holds nothing for these days" are
  // different facts and are never printed as the same sentence.
  const ledgerRead = overview.error === null && overview.sections.ledger === null;
  const paidRead = overview.error === null && overview.sections.paidLedger === null;
  const collectedMetric: Metric = overview.frontEnd
    ? measured(overview.frontEnd.collected)
    : unmeasured(
        ledgerRead ? "no ledger collections for this window" : "the ledger read did not answer",
      );
  const paid = overview.paidFrontEnd;
  const paidMetric: Metric = paid
    ? measured(paid.paidExGst)
    : unmeasured(
        paidRead ? "no ledger collections for this window" : "the ledger read did not answer",
      );
  const roas = paidFrontEndRoas(paidMetric, t.spend);
  const blendedRatio = blendedCashRatio(collectedMetric, t.spend);
  // ALL TIERS, not just the front end. The front-end figure alone reads as 0.44
  // and had the owner making budget decisions against 8% of the money.
  const allTier = useQuery({
    queryKey: ["all-tier-cash", range.since, range.until],
    queryFn: () => getAllTierCash({ data: { since: range.since, until: range.until } }),
  });
  const allTierCash: Metric =
    allTier.data && allTier.data.error === null && allTier.data.rows.length > 0
      ? measured(
          allTier.data.rows.reduce(
            (sum: number, r: TierCashRow) => sum + (toNum(r.collected) ?? 0),
            0,
          ),
        )
      : unmeasured(
          allTier.data?.error ? "the ledger read did not answer" : "no ledger cash in this window",
        );
  const allTierRatio = blendedCashRatio(allTierCash, t.spend);
  // If paid-attributed cash climbs to within 5% of all cash, attribution has
  // stopped telling the two apart — that is a coverage failure, not a win.
  const attributionConverged = paid !== null && paid.all > 0 && paid.paidGross / paid.all >= 0.95;

  // Withhold only when the facts themselves are missing. A run that finished
  // thin, or a feed judged behind while its data still reaches today, gets a
  // caution beside the figures — never a blanked screen.
  const blockingBroken = withholdingFeeds(overview.feeds);
  const withheld = blockingBroken.length > 0;
  const cautions = cautionFeeds(overview.feeds);
  const deltaGuard = coverageDeltaGuard(t, priorT, coverage ?? null);
  const suppressDeltas = deltaGuard.suppress;
  const suppressReason = deltaGuard.reason;


  const scaling = useScalingWatch();
  const scalingOpen = scalingDemandsAttention(scaling);
  const briefTeaser = useBriefTeaser();

  // Degradation rule: green means verified healthy. If the verdict query
  // failed, or the day could not be resolved, or nothing was testable, the
  // screen says so — it never falls through to an all-clear.
  const verdictBroken = verdictData.error !== null || verdictData.verdict.asof === null;
  // A failed read is not an empty result. Every section fed by the overview
  // query defers to the outage banner rather than printing a zero, a "0 of 0",
  // or a "no data" that the owner would read as a measured fact.
  // P0-A: sections fail INDEPENDENTLY. One slow query must not empty the whole
  // screen, and a section whose own query failed must never assert a zero.
  const sec = overview.sections;
  const whole = overview.error;
  const accountsFailed = whole !== null || sec.accounts !== null;
  const feedsFailed = whole !== null || sec.feeds !== null;
  const ledgerFailed = whole !== null || sec.ledger !== null || sec.paidLedger !== null;
  const kpiFailed = accountsFailed;
  // ONE definition of "checked", shared with the green panel: measures that
  // passed the gates and were actually tested against their usual range.
  const checkedCount = verdictData.verdict.checked;
  const holdingTeaser = verdictBroken
    ? "checks could not run"
    : checkedCount === 0
      ? "nothing could be tested today"
      : `${count(checkedCount)} measures tested, ${count(verdictData.verdict.holding.length)} inside their usual range`;

  async function onSync(payload?: { since: string; until: string }) {
    const result = await runSync({ data: payload ?? {} });
    if (result.status === "error") {
      throw new Error(result.error ?? "Sync failed without an error message.");
    }
    return `${result.status === "partial" ? "Partial sync" : "Sync complete"} · ${count(result.rowsWritten)} rows · ${result.since} → ${result.until}`;
  }

  const untilToday = new Date().toISOString().slice(0, 10);

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
            title="Today"
            search={search}
            range={range}
            onChange={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
            right={
              <>
                <CoverageNotice preset={search.range} coverage={coverage} />
                <RegimeNotice
                  crossings={regimeCrossings(overview.regimes, overview.range, overview.prior)}
                />

                {feedsFailed ? null : <WorstFeedChip feeds={overview.feeds} />}
                <DataMenu
                  actions={[
                    {
                      key: "sync",
                      label: "Sync Meta Ads",
                      description: "Pulls the recent days of insights for every active account.",
                      run: () => onSync(),
                    },
                    {
                      key: "backfill",
                      label: "Backfill from 1 January",
                      description: "Re-pulls daily insights for the whole year.",
                      confirm: `Backfill every active account from 2026-01-01 to ${untilToday}? This re-pulls daily Meta insights and can run for several minutes.`,
                      run: () => onSync({ since: "2026-01-01", until: untilToday }),
                    },
                  ]}
                />
              </>
            }
          />
        }
      >
        <div className="px-4 py-5 md:px-6">
          {whole !== null ? <EngineUnreadable detail={whole} /> : null}

          {withheld ? <WithheldPanel feeds={blockingBroken} /> : null}

          {withheld ? null : <FeedCautionPanel feeds={cautions} />}

          {withheld ? null : (
            <>
              {/* LAYER 1 — is anything wrong today? */}
              <section className="mb-5">
                {verdictBroken ? (
                  <>
                    {overview.error ? null : <EngineUnreadable detail={verdictData.error} />}
                    <ChecksCouldNotRun
                      reason={
                        verdictData.error !== null
                          ? "the database did not answer"
                          : "the day being measured could not be resolved"
                      }
                    />
                  </>
                ) : (
                  <>
                    <VerdictCoverageLine
                      asof={verdictData.verdict.asof}
                      today={new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" })}
                      perforated={coverage?.interiorGaps ?? []}
                    />
                    <VerdictSentence
                      asof={verdictData.verdict.asof}
                      sentence={verdictData.sentence}
                    />
                    <ProofLine ids={["meta_spend", "sales_count"]} className="mt-2" />
                    <TokenExpiryNotice feeds={verdictData.feeds} />
                    {verdictData.verdict.flagged.length > 0 ? (
                      <AttentionCards flagged={verdictData.verdict.flagged} />
                    ) : (
                      <AllClear verdict={verdictData.verdict} />
                    )}
                  </>
                )}
              </section>

              <PromotionNote since={range.since} until={range.until} />

              {kpiFailed ? (
                <SectionUnavailable
                  title="Spend, registrations and cash"
                  detail={sec.accounts ?? whole}
                />
              ) : (
              <>
              <section className="border-border bg-card grid grid-cols-2 rounded-md border md:grid-cols-4">
                <Kpi
                  label="Meta spend"
                  metric={t.spend}
                  format="inr"
                  provenance="meta_spend"
                  hint={`${range.since} → ${range.until}`}
                  prior={search.compare ? priorT.spend : undefined}
                  suppressDelta={suppressDeltas}
                  suppressReason={suppressReason}
                />
                <Kpi
                  label="Registrations (measured accounts)"
                  metric={t.measuredLeads}
                  format="int"
                  provenance="registrations"
                  hint="accounts with working lead tracking only"
                  prior={search.compare ? priorT.measuredLeads : undefined}
                  suppressDelta={suppressDeltas}
                  suppressReason={suppressReason}
                />
                <Kpi
                  contract="cost_per_registration"
                  label="Cost per registration (measured accounts only)"
                  metric={t.costPerMeasuredRegistration}
                  format="inr"
                  hint={
                    t.unmeasuredSpend.value
                      ? `${inrText(t.unmeasuredSpend.value)} of ${t.spend.value === null ? NO_DATA : inrText(t.spend.value)} spent on accounts with no working lead tracking is excluded.`
                      : undefined
                  }
                  prior={search.compare ? priorT.costPerMeasuredRegistration : undefined}
                  suppressDelta={suppressDeltas}
                  suppressReason={suppressReason}
                  footer={
                    teamRatios && headroom.value !== null ? (
                      <span className="text-muted-foreground">
                        headroom{" "}
                        <MetricValue
                          metric={{ ...headroom, value: headroom.value * 100 }}
                          format="percent"
                        />{" "}
                        of ceiling
                      </span>
                    ) : undefined
                  }
                />
                <Kpi
                  label="Paid front-end ROAS (ex-GST)"
                  metric={roas}
                  format="ratio"
                  contract="front_end_roas"
                  provenance="front_end_roas"
                  hint={
                    paid
                      ? `${inrText(paid.paidExGst)} from ad-attributed new sales, ex-GST ÷ Meta spend, same window · excludes ${inrText(paid.noLead)} from buyers with no lead record and ${inrText(paid.instalment)} of instalments on earlier sales${attributionConverged ? " · WARNING: this is within 5% of all L1 cash — attribution coverage has collapsed" : ""}`
                      : paidRead
                        ? "no ledger collections in this window"
                        : "the ledger read did not answer, so this ratio is not stated"
                  }
                  note={
                    paid && paid.unsyncedGross > 0
                      ? `${inrText(paid.unsyncedGross)} from teams whose ad spend is not yet connected — excluded from this ratio, shown in team counts`
                      : undefined
                  }
                />
                <Kpi
                  label="All-tier return (gross)"
                  metric={teamRatios ? allTierRatio : unmeasured("the ledger has no team key")}
                  format="ratio"
                  hint={
                    allTierCash.value === null
                      ? "the ledger read did not answer, so this ratio is not stated"
                      : `${inrText(allTierCash.value)} collected across every tier in this window ÷ Meta spend · includes buyers acquired in earlier months, so it is a business return, not an ad-performance figure`
                  }
                  note="front-end return above is one part of this — see Cohort return for what each month's buyers pay back over time"
                />
              </section>

              {accountsFailed ? null : <CoverageLine totals={t} />}
              </>
              )}

              {/* LAYER 2 — everything that was here before, one tap away. */}
              <div className="mt-4 space-y-3">
                <Disclosure title="Checks" teaser={holdingTeaser}>
                  <HoldingLine holding={verdictData.verdict.holding} />
                  <NotMeasuredLine candidates={verdictData.verdict.notMeasured} />
                </Disclosure>

                <Disclosure title="Morning brief" teaser={briefTeaser ?? "no brief written yet"}>
                  <AnalystBrief bare />
                </Disclosure>

                {ledgerFailed ? (
                  <SectionUnavailable
                    title="Cash & ceiling"
                    detail={sec.ledger ?? sec.paidLedger ?? whole}
                  />
                ) : (
                  <Disclosure
                    title="Cash & ceiling"
                    teaser={
                      collectedMetric.value === null
                        ? ledgerRead
                          ? "no ledger collections in this window"
                          : "the ledger read did not answer"
                        : `${inrText(collectedMetric.value)} of L1 cash from all sources${
                            search.agency ? " — all teams, the ledger has no team key" : ""
                          }`

                    }
                  >
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div>
                        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          Blended L1 cash (all sources)
                        </div>
                        <div className="nums mt-1.5 flex items-baseline gap-1.5 text-2xl">
                          <MetricValue
                            metric={collectedMetric}
                            format="inr"
                            emphasis
                            contract="l1_collected_all_sources"
                          />
                          {collectedMetric.value === null ? null : <Provenance metric="collected" />}
                        </div>
                        <div className="mt-0.5 space-y-0.5 text-[11px] text-muted-foreground">
                          <div>
                            {teamRatios ? (
                              <>
                                <MetricValue metric={blendedRatio} format="ratio" /> against Meta
                                spend
                              </>
                            ) : (
                              "ratio against spend: not measurable per team — teams share ad accounts"
                            )}
                          </div>
                          <div>
                            includes organic/podcast buyers and instalments from earlier sales — not
                            an ad-performance figure
                          </div>
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          Break-even ceiling
                        </div>
                        <div className="nums mt-1.5 text-2xl">
                          <MetricValue metric={ceilingMetric} format="inr" emphasis />
                        </div>
                        <div className="mt-0.5 space-y-0.5 text-[11px] text-muted-foreground">
                          <div>
                            {!teamRatios ? (
                              "not measurable per team — teams share ad accounts"
                            ) : headroom.value === null ? (
                              "set the inputs in Settings"
                            ) : (
                              <>
                                currently at{" "}
                                <MetricValue
                                  metric={{ ...headroom, value: headroom.value * 100 }}
                                  format="percent"
                                />{" "}
                                of ceiling
                              </>
                            )}
                          </div>
                          <div title={resolved.ceiling.note ?? undefined}>
                            {resolved.measuredBackend && resolved.measuredAscension
                              ? `back end ${inrText(resolved.backendPrice)} and ${resolved.ascensionRate}% ascension, both read from the ledger`
                              : "some inputs are still assumed — set them in Settings"}
                          </div>
                        </div>
                      </div>
                    </div>
                  </Disclosure>
                )}

                <Disclosure
                  title="Scaling"
                  defaultOpen={scalingOpen}
                  openReason={
                    scaling?.is_monday
                      ? "Monday"
                      : scaling && !scaling.weekly_verdict.favours_raising_budget
                        ? "conditions failing"
                        : undefined
                  }
                  teaser={
                    scaling
                      ? `efficiency ${scaling.efficiency_direction}`
                      : "written with the morning brief"
                  }
                >
                  <ScalingWatchPanel scaling={scaling} />
                </Disclosure>
              </div>

              {accountsFailed ? (
                <SectionUnavailable
                  title="Accounts with spend"
                  detail={sec.accounts ?? whole}
                  className="mt-4"
                />
              ) : (
                <>
                  <section className="border-border bg-card mt-4 rounded-md border">
                    <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Accounts with spend
                      </h2>
                      <span className="text-[11px] text-muted-foreground">
                        {count(active.length)} of {count(views.length)} accounts spent in this range
                      </span>
                    </div>
                    {active.length === 0 ? (
                      <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                        No account spent anything in this range.
                      </div>
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <AccountsTable views={shownAccounts} totals={t} compact />
                        </div>
                        {shownAccounts.length < activeRanked.length ? (
                          <button
                            type="button"
                            onClick={() => setSeeAllAccounts(true)}
                            className="border-border w-full border-t px-4 py-2 text-[12px] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                          >
                            see all {count(activeRanked.length)} accounts ▸
                          </button>
                        ) : null}
                      </>
                    )}
                  </section>

                  <QuietAccounts views={views.filter((v) => !((v.spend.value ?? -1) > 0))} />
                </>
              )}
            </>
          )}
        </div>
      </AppShell>
    </FilterScope>
  );
}

function QuietAccounts({ views }: { views: ReturnType<typeof accountView>[] }) {
  if (views.length === 0) return null;
  return (
    <Disclosure
      className="mt-4"
      title="Quiet accounts"
      teaser={`${count(views.length)} account${views.length === 1 ? "" : "s"} with no spend in this range`}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <tbody>
            {views.map((v) => {
              // An observed zero is a measured fact and prints as ₹0.
              // Silence from the source is not, and prints as NO_DATA.
              const label = !v.row.is_active ? "ended" : v.observedZeroSpend ? inrText(0) : NO_DATA;
              return (
                <tr
                  key={v.row.account_id}
                  className="border-border border-t text-muted-foreground [&>td]:px-2 [&>td]:py-1.5"
                >
                  <td>{v.row.name}</td>
                  <td className="text-[11px] uppercase tracking-wider">
                    {v.row.agency_code ?? "—"}
                  </td>
                  <td className="nums text-right text-xs">{label}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Disclosure>
  );
}
