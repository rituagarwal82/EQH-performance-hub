import { SectionUnavailable } from "@/components/DataOutage";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { UiError, RouteError } from "@/components/UiError";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { CoverageLine } from "@/components/CoverageLine";
import { MetricValue } from "@/components/MetricValue";
import { GoldenStatusPanel } from "@/components/GoldenStatusPanel";
import { MaintenancePanel } from "@/components/MaintenancePanel";
import { ProofPanel } from "@/components/ProofPanel";
import { RangeBar } from "@/components/RangeBar";
import { SyncHealthPanel } from "@/components/SyncHealthPanel";

import { accountView, totals as computeTotals } from "@/lib/account-view";
import { count } from "@/lib/counts";
import {
  getLeadTemplateTrend,
  getLeadTrackingCoverage,
  getNameMatchOrphans,
} from "@/lib/leads.functions";
import { fromNullable, rate } from "@/lib/metric";
import { overviewQuery } from "@/lib/overview-query";
import { validateRangeSearch } from "@/lib/range-search";

export const Route = createFileRoute("/_authenticated/trust")({
  validateSearch: validateRangeSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(overviewQuery(deps)),
  head: () => ({
    meta: [
      { title: "Data Trust — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Which Energy Queens Hub numbers are measured, which are unknown, and exactly how much spend sits behind each state.",
      },
      { property: "og:title", content: "Data Trust — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "Measurement health per ad account: working, no lead tracking, or unverified lead tracking.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: TrustPage,
  errorComponent: ({ error, reset }) => (
    <RouteError error={error} reset={reset} subject="the trust view" where="src/routes/trust.tsx" />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

const STATUS_LABEL: Record<string, string> = {
  working: "Lead tracking working",
  broken: "No lead tracking — ads deliver, but the lead event reports nothing to Meta",
  unknown: "Lead tracking unverified",
  not_applicable: "Not a lead-generation account",
  retargeting: "Retargeting / brand — not expected to create new leads",
};

function TrustPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/trust" });
  const { data: overview } = useSuspenseQuery(overviewQuery(search));
  const range = overview.range;
  const rangeDays = overview.coverage?.clippedDays;

  const views = overview.accounts.map((r) => accountView(r, { rangeDays }));
  const t = computeTotals(views);

  const buckets = new Map<string, ReturnType<typeof accountView>[]>();
  for (const v of views) {
    // A retargeting / brand account has no lead event by design, so listing it
    // as "no lead tracking — broken" was a contradiction, not a fault.
    const key =
      v.role === "retargeting_brand" ? "retargeting" : (v.row.lead_tracking_status ?? "unknown");
    buckets.set(key, [...(buckets.get(key) ?? []), v]);
  }
  const order = ["broken", "unknown", "working", "retargeting", "not_applicable"];
  const groups = order.filter((k) => buckets.has(k)).map((k) => [k, buckets.get(k)!] as const);

  const missingDays = views
    .map((v) => ({ v, days: fromNullable(v.row.days_missing_leads).value }))
    .filter(
      (row): row is { v: (typeof views)[number]; days: number } =>
        row.days !== null && row.days > 0,
    );

  const leadGen = views.filter((v) => v.role !== "retargeting_brand");
  const workingSpend = computeTotals(
    views.filter((v) => v.row.lead_tracking_status === "working"),
  ).spend;
  const trustLine =
    views.length === 0
      ? "No accounts are readable for this window, so nothing on this screen can be judged — that is an outage, not a clean bill of health."
      : `${count(leadGen.length)} lead-generation ad accounts in this window. ${count(
          (buckets.get("working") ?? []).length,
        )} have working lead tracking, ${count(
          (buckets.get("broken") ?? []).length,
        )} are broken and ${count(
          (buckets.get("unknown") ?? []).length,
        )} are unknown. Retargeting / brand accounts are listed separately — they are not expected to create new leads. Registration figures and every cost-per-registration count only the working accounts; the rest contribute spend and no registrations.`;

  return (
    <AppShell
      topBar={
        <RangeBar
          title="Data Trust"
          search={search}
          range={range}
          onChange={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
        />
      }
    >
      <div className="px-6 py-5">
        <p className="border-border bg-card mb-4 rounded-md border px-4 py-3 text-[13px] leading-relaxed">
          {trustLine}
        </p>

        <ProofPanel />

        <div className="mt-5">
          <MaintenancePanel />
        </div>

        <div className="mt-5">
          <GoldenStatusPanel />
        </div>

        <div className="mt-5">
          <SyncHealthPanel />
        </div>

        <div className="mt-5">
          <CoverageLine totals={t} />
        </div>

        <p className="mt-3 text-[12px] text-muted-foreground">
          Every figure elsewhere in this app inherits the weakest state of its inputs. This screen
          is where that state is decided. Lead tracking status is set per account in Settings;
          nothing here is inferred from the data itself.
        </p>

        <LeadTrackingLine />

        {groups.map(([status, list]) => {
          const spend = computeTotals(list).spend;
          return (
            <section key={status} className="border-border bg-card mt-4 rounded-md border">
              <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {STATUS_LABEL[status] ?? status}
                </h2>
                <span className="nums text-[11px] text-muted-foreground">
                  {count(list.length)} accounts · <MetricValue metric={spend} format="inr" /> in
                  range
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                      <th className="text-left">Account</th>
                      <th className="text-left">Team</th>
                      <th className="text-left">State</th>
                      <th className="text-right">Spend</th>
                      <th className="text-right">Registrations</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list
                      .slice()
                      .sort((a, b) => (b.spend.value ?? -Infinity) - (a.spend.value ?? -Infinity))
                      .map((v) => (
                        <tr
                          key={v.row.account_id}
                          className="border-border border-b last:border-b-0 [&>td]:px-3 [&>td]:py-1.5"
                        >
                          <td className="font-medium">{v.row.name}</td>
                          <td className="text-[11px] uppercase tracking-wider text-muted-foreground">
                            {v.row.agency_code ?? "—"}
                          </td>
                          <td className="text-[11px] text-muted-foreground">
                            {v.row.is_active ? "active" : "ended"}
                          </td>
                          <td className="nums text-right">
                            <MetricValue metric={v.spend} format="inr" />
                          </td>
                          <td className="nums w-40 text-right">
                            <MetricValue metric={v.leads} format="int" />
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="border-border border-t px-4 py-2 text-[11px] leading-snug text-muted-foreground">
                {count(list.length)} accounts · {range.since} → {range.until} · nothing excluded —
                every account with this tracking state is listed
              </div>
            </section>
          );
        })}

        <section className="border-border bg-card mt-4 rounded-md border">
          <div className="border-border border-b px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Days where Meta returned no registration data
          </div>
          {overview.error !== null || overview.sections.accounts !== null ? (
            <p className="px-4 py-4 text-[12px] text-muted-foreground">
              This could not be checked — the account read did not answer, so this is not an
              all-clear.
            </p>
          ) : missingDays.length === 0 ? (
            <p className="px-4 py-4 text-[12px] text-muted-foreground">
              Every active account returned registration data for every day in this range.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                    <th className="text-left">Account</th>
                    <th className="text-right">Days without registration data</th>
                  </tr>
                </thead>
                <tbody>
                  {missingDays.map(({ v, days }) => (
                    <tr
                      key={v.row.account_id}
                      className="border-border border-b last:border-b-0 [&>td]:px-3 [&>td]:py-1.5"
                    >
                      <td>{v.row.name}</td>
                      <td className="nums text-right text-warning">
                        {count(days)} days without registration data
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-border border-t px-4 py-2 text-[11px] leading-snug text-muted-foreground">
            {count(missingDays.length)} accounts with missing days · {range.since} → {range.until} ·
            accounts that returned data every day are not listed
          </div>
        </section>
      </div>
    </AppShell>
  );
}

/**
 * Tracking coverage on the lead feed itself: how many recent leads carry the
 * Meta ad id the campaign rollups need. Stated as a fact about measurement,
 * not folded into any performance number.
 */
function LeadTrackingLine() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["lead-tracking-coverage", 30],
    queryFn: () => getLeadTrackingCoverage({ data: { days: 30 } }),
  });
  const cov = data?.coverage;
  if (isLoading) return <p className="mt-3 text-[12px] text-muted-foreground">Reading…</p>;
  if (isError || !cov)
    return (
      <SectionUnavailable
        title="Lead tracking coverage"
        detail={error instanceof Error ? error.message : null}
        className="mt-3"
      />
    );

  const total = Number(cov.leads_total) || 0;
  if (total === 0) {
    return (
      <p className="mt-3 text-[12px] text-muted-foreground">
        No lead records in the last 30 days, so tracking coverage cannot be measured.
      </p>
    );
  }

  const adPct = rate(cov.with_ad_id, cov.leads_total);
  const refPct = rate(cov.with_ad_ref, cov.leads_total);
  const campPct = rate(cov.with_campaign, cov.leads_total);
  const emailPct = rate(cov.with_email, cov.leads_total);
  const named = (Number(cov.name_exact) || 0) + (Number(cov.name_fuzzy) || 0);

  return (
    <div className="border-border bg-card mt-3 rounded-md border px-4 py-2.5 text-[12px] leading-relaxed">
      <span className="font-semibold">Lead tracking coverage, last 30 days.</span> {count(total)}{" "}
      lead records, {count(Number(cov.registered) || 0)} of them registered.{" "}
      <MetricValue metric={campPct} format="percent" /> carry a campaign name and{" "}
      <MetricValue metric={emailPct} format="percent" /> an email address. Only leads with an email
      can be matched to a sale.
      <ul className="mt-2 space-y-0.5">
        <li>
          <span className="text-muted-foreground">Directly tracked (ad id):</span>{" "}
          <MetricValue metric={adPct} format="percent" />{" "}
          <span className="text-muted-foreground">
            ({count(Number(cov.with_ad_id) || 0)} records)
          </span>
        </li>
        <li>
          <span className="font-medium">Effective attribution (ad id + ad-name match):</span>{" "}
          <MetricValue metric={refPct} format="percent" />{" "}
          <span className="text-muted-foreground">
            ({count(Number(cov.with_ad_ref) || 0)} records, {count(named)} of them recovered by ad
            name)
          </span>
        </li>
      </ul>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Effective attribution is the number the creative intelligence layer uses — a name-matched
        lead is a matched lead.
      </p>
      {Number(cov.without_email) > 0 ? (
        <p className="mt-2 text-muted-foreground">
          {count(Number(cov.without_email))} records have no email and are counted here but can
          never join to revenue.
        </p>
      ) : null}
      {/* Conventions apply whatever the current coverage is, so this note is
          not tucked inside the low-coverage branch below. */}
      <p className="mt-2 text-muted-foreground">
        Offline talks and events: any QR code or link shared at the event should carry
        utm_source=talk_&lt;organisation&gt; (for example talk_yflo, talk_rotary). Anything tagged
        that way is read as a talk automatically, with the organisation name as the source — no
        change to the app is needed for a new talk.
      </p>
      {(refPct.value ?? 0) < 90 ? (
        <>
          <p className="mt-2 text-muted-foreground">
            All 4 landing pages capture attribution. The remaining gap is ads still running the old
            URL template (utm_source=Meta), which carries the ad name in utm_content instead of the
            ad id. Those ads are intentionally left running (learning-phase protection) and are
            attributed by ad name; they will age out naturally. New-template ads
            (FACEBOOK/FACEBOOK_PW/FACEBOOK_P) carry the ad id directly.
          </p>
          <NameMatchHealth />
          <TemplateTrend />
        </>
      ) : null}
    </div>
  );
}

/** Name matching breaks silently when an ad is renamed — count the breakage. */
function NameMatchHealth() {
  const { data, isError } = useQuery({
    queryKey: ["lead-name-orphans", 30],
    queryFn: () => getNameMatchOrphans({ data: { days: 30 } }),
  });
  const o = data?.orphans;
  const leads = Number(o?.orphan_leads ?? 0) || 0;
  if (isError || !o)
    return <SectionUnavailable title="Ad-name matching" detail={null} className="mt-2" />;
  if (leads === 0)
    return (
      <p className="mt-2 text-[11px] text-muted-foreground">
        Every lead in the last 30 days that carries an ad name matches an ad we know about.
      </p>
    );
  return (
    <p className="mt-2 text-[11px] text-muted-foreground">
      {count(leads)} leads in the last 30 days carry an ad-name value that matches no current ad
      name ({count(Number(o.orphan_names) || 0)} distinct names). Either the ad was renamed, or the
      value was never a Meta ad name.
      {o.sample?.length ? <> Most common: {o.sample.slice(0, 3).join(" · ")}.</> : null}
    </p>
  );
}

/** Day-by-day view of the URL-template retrofit, so progress is visible. */
function TemplateTrend() {
  const { data, isError, error } = useQuery({
    queryKey: ["lead-template-trend", 14],
    queryFn: () => getLeadTemplateTrend({ data: { days: 14 } }),
  });
  const rows = isError ? [] : (data?.rows ?? []);
  if (isError)
    return (
      <SectionUnavailable
        title="Older ad links, day by day"
        detail={error instanceof Error ? error.message : null}
        className="mt-3"
      />
    );
  if (rows.length === 0) return null;

  return (
    <div className="border-border mt-3 border-t pt-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Old-template ads · registered leads per day
      </div>
      <div className="overflow-x-auto">
        <table className="mt-1 w-full text-[11px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:py-1 [&>th]:font-medium">
              <th className="text-left">Day</th>
              <th className="text-right">Old template</th>
              <th className="text-right">…with ad id</th>
              <th className="text-right">…attributed (id + name)</th>
              <th className="text-right">New template</th>
              <th className="text-right">…with ad id</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.day} className="[&>td]:py-0.5">
                <td className="text-muted-foreground">{r.day}</td>
                <td className="nums text-right">{count(Number(r.old_leads) || 0)}</td>
                <td className="nums text-right">{count(Number(r.old_with_ad_id) || 0)}</td>
                <td className="nums text-right">{count(Number(r.old_with_ref) || 0)}</td>
                <td className="nums text-right">{count(Number(r.new_leads) || 0)}</td>
                <td className="nums text-right">{count(Number(r.new_with_ad_id) || 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
