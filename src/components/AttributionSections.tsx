import { queryOptions, useQuery } from "@tanstack/react-query";
import { UiError } from "@/components/UiError";
import { Link } from "@tanstack/react-router";

import { MetricValue } from "@/components/MetricValue";
import { getAttribution, type BucketRow } from "@/lib/attribution.functions";
import { fromNullable, rate } from "@/lib/metric";

export const attributionQuery = (since: string, until: string) =>
  queryOptions({
    queryKey: ["ledger-attribution", since, until],
    queryFn: () => getAttribution({ data: { since, until } }),
  });

const BUCKET_LABEL: Record<string, { label: string; hint: string; tone: string }> = {
  PAID: {
    label: "Produced by paid traffic",
    hint: "email matches a lead record carrying paid-traffic markers",
    tone: "border-primary/50 bg-primary/5",
  },
  LEAD_NOT_PAID: {
    label: "Lead record, no paid markers",
    hint: "entered a tracked funnel, but nothing marks it as paid traffic (e.g. Zoom re-registration, bio link)",
    tone: "border-border",
  },
  NO_LEAD_RECORD: {
    label: "No lead record at all",
    hint: "never entered a tracked funnel — podcast, organic, referral. Identified by absence, never by a guessed label.",
    tone: "border-amber-500/50 bg-amber-500/5",
  },
};

const ORDER = ["PAID", "LEAD_NOT_PAID", "NO_LEAD_RECORD"];

/**
 * Attribution comes from the LEAD RECORD, joined to the ledger on lowercased
 * trimmed email. The ledger's own Source of Student is never used — tested, it
 * disagrees with the lead's utm_source on 93% of sales.
 */
export function AttributionSections({ since, until }: { since: string; until: string }) {
  const { data, isLoading } = useQuery(attributionQuery(since, until));

  const buckets = (data?.buckets ?? [])
    .slice()
    .sort(
      (a: BucketRow, b: BucketRow) =>
        ORDER.indexOf(String(a.bucket)) - ORDER.indexOf(String(b.bucket)),
    );
  const cov = data?.coverage ?? null;
  const coveragePct = cov ? rate(cov.matched, cov.buyers) : fromNullable(null);
  const campaignPct = cov ? rate(cov.with_campaign, cov.buyers) : fromNullable(null);

  return (
    <div className="space-y-3">
      <div className="rounded border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">Attribution rule in force:</span> the ledger
        owns the sale and the money; the{" "}
        <span className="font-medium text-foreground">lead record</span> owns the attribution. They
        are joined on lowercased, trimmed email. A sale counts as performance marketing{" "}
        <span className="font-medium text-foreground">only</span> if its email matches a lead record
        carrying paid-traffic markers — everything else is{" "}
        <span className="font-mono">NOT_ATTRIBUTABLE_TO_PAID</span>. The accounts ledger's{" "}
        <span className="font-mono">Source of Student</span> is stored for reference and is{" "}
        <span className="font-medium text-foreground">never used in any calculation</span>: tested
        against the leads' own utm_source it disagreed on 93% of sales.
      </div>

      {!data?.hasLeads ? (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px]">
          No lead records have been loaded yet, so no sale can be attributed to paid traffic. Until
          the lead feed is connected, every sale sits in{" "}
          <span className="font-mono">NOT_ATTRIBUTABLE_TO_PAID</span> — nothing here is estimated.
        </div>
      ) : null}

      {data?.error ? (
        <div
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
        >
          <UiError detail={data.error} subject="attribution" where="attribution sections" />
        </div>
      ) : null}

      <section className="grid gap-2 md:grid-cols-3">
        {ORDER.map((key) => {
          const meta = BUCKET_LABEL[key]!;
          const row = buckets.find((b) => String(b.bucket) === key);
          return (
            <div key={key} className={`rounded border px-3 py-2 ${meta.tone}`}>
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {meta.label}
              </div>
              <div className="mt-0.5 font-mono text-lg tabular-nums">
                {isLoading ? (
                  "…"
                ) : (
                  <MetricValue
                    metric={row ? fromNullable(row.sales) : fromNullable(null)}
                    format="int"
                  />
                )}
                <span className="ml-1 text-[11px] text-muted-foreground">sales</span>
              </div>
              <div className="font-mono text-[12px] tabular-nums text-muted-foreground">
                <MetricValue
                  metric={row ? fromNullable(row.collected) : fromNullable(null)}
                  format="inr"
                />
              </div>
              <div className="mt-1 text-[10px] leading-tight text-muted-foreground">
                {meta.hint}
              </div>
            </div>
          );
        })}
      </section>

      <p className="text-[11px] text-muted-foreground">
        Lead-record coverage:{" "}
        <span className="font-mono tabular-nums text-foreground">
          <MetricValue metric={cov ? fromNullable(cov.matched) : fromNullable(null)} format="int" />{" "}
          of{" "}
          <MetricValue metric={cov ? fromNullable(cov.buyers) : fromNullable(null)} format="int" />
        </span>{" "}
        buyers in range match a lead record (
        <MetricValue metric={coveragePct} format="percent" />
        ). Campaign is known for{" "}
        <span className="font-mono tabular-nums text-foreground">
          <MetricValue
            metric={cov ? fromNullable(cov.with_campaign) : fromNullable(null)}
            format="int"
          />
        </span>{" "}
        of them (
        <MetricValue metric={campaignPct} format="percent" />
        ). Unmatched buyers are listed in the{" "}
        <Link
          to="/queue"
          search={{ range: "this_year", compare: false }}
          className="underline underline-offset-2"
        >
          review queue
        </Link>
        .
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h2 className="mb-1 text-[12px] font-semibold">By platform / ad account</h2>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-[12px]">
              <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Platform</th>
                  <th className="px-3 py-1.5 text-left font-medium">Counts as paid</th>
                  <th className="px-3 py-1.5 text-right font-medium">Sales</th>
                  <th className="px-3 py-1.5 text-right font-medium">Collected</th>
                </tr>
              </thead>
              <tbody>
                {(data?.platforms ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-2 py-6 text-center text-muted-foreground">
                      <MetricValue metric={fromNullable(null)} format="int" />
                    </td>
                  </tr>
                ) : (
                  data!.platforms.map((p) => (
                    <tr
                      key={`${p.platform}-${String(p.is_paid)}`}
                      className="border-t border-border/60 hover:bg-muted/40"
                    >
                      <td className="px-3 py-1 font-medium">
                        {p.platform === "organic_search"
                          ? "Organic search (no media cost)"
                          : p.platform}
                      </td>

                      <td className="px-3 py-1 text-muted-foreground">
                        {p.is_paid ? "yes" : "no"}
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromNullable(p.sales)} format="int" />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromNullable(p.collected)} format="inr" />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            These are platforms and ad accounts, not agencies.{" "}
            <span className="font-mono">zoom</span> is a re-registration from a Zoom link and{" "}
            <span className="font-mono">bio</span> is an Instagram bio link — neither is a paid
            acquisition source.{" "}
            <span className="font-medium text-foreground">Organic search</span> is traffic tagged
            google or youtube with no Google Ads click id — Google Ads is not running, so these
            sales carry no media cost.
          </p>
        </section>

        <section>
          <h2 className="mb-1 text-[12px] font-semibold">By campaign</h2>
          <div className="overflow-x-auto rounded border border-border">

            <table className="w-full text-[12px]">
              <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">Campaign</th>
                  <th className="px-3 py-1.5 text-left font-medium">Platform</th>
                  <th className="px-3 py-1.5 text-right font-medium">Sales</th>
                  <th className="px-3 py-1.5 text-right font-medium">Collected</th>
                </tr>
              </thead>
              <tbody>
                {(data?.campaigns ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-2 py-6 text-center text-muted-foreground">
                      <MetricValue metric={fromNullable(null)} format="int" />
                    </td>
                  </tr>
                ) : (
                  data!.campaigns.map((c, i) => (
                    <tr
                      key={`${c.utm_campaign ?? "none"}-${i}`}
                      className="border-t border-border/60 hover:bg-muted/40"
                    >
                      <td className="px-3 py-1 font-mono">
                        {c.utm_campaign ?? (
                          <span className="text-muted-foreground">no campaign on the lead</span>
                        )}
                      </td>
                      <td className="px-3 py-1 text-muted-foreground">{c.platform}</td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromNullable(c.sales)} format="int" />
                      </td>
                      <td className="px-3 py-1 text-right font-mono tabular-nums">
                        <MetricValue metric={fromNullable(c.collected)} format="inr" />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="rounded border border-dashed border-border px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-[12px] font-semibold">By agency</h2>
          <span className="rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
            not yet measurable
          </span>
        </div>
        <p className="mt-1 max-w-3xl text-[11px] text-muted-foreground">
          No agency code exists in the historical lead data, so no sale can honestly be credited to
          an agency. The historical utm values are ad accounts and platforms —{" "}
          <span className="font-mono">RituAgarwal2</span> is an ad account, and several agencies
          have run inside it. This dimension will fill in once ad-level URL parameters carrying
          agency codes go live; nothing before that point will be backfilled by guessing.
        </p>
      </section>
    </div>
  );
}
