import { DataMenu } from "@/components/DataMenu";
import { triggerSync } from "@/lib/dashboard.functions";
import { UiError } from "@/components/UiError";
import { RouteError } from "@/components/UiError";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getBrief } from "@/lib/analyst.functions";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "@/components/AppShell";
import { SafetyNetPanel } from "@/components/SafetyNetPanel";
import { count } from "@/lib/counts";
import { FEED_TONE, feedAgePhrase, feedAsAt, type FeedHealthRow } from "@/lib/feed-health";
import { feedSeverity, TIER_NOTE, TIER_PANEL } from "@/lib/severity";
import { feedScreenQuery } from "@/lib/verdict-query";

import type { FeedStripRow } from "@/lib/verdict.functions";

export const Route = createFileRoute("/_authenticated/health")({
  loader: ({ context }) => context.queryClient.ensureQueryData(feedScreenQuery()),
  head: () => ({
    meta: [
      { title: "Feed Health — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Every data feed behind the Energy Queens Hub dashboard: state, last success, coverage edge, rows written and the last error verbatim, with a 30-day collection strip.",
      },
      { property: "og:title", content: "Feed Health — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "Which feeds are live, late, stale or broken — and exactly which day each one stopped collecting.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HealthPage,
  errorComponent: ({ error, reset }) => (
    <RouteError error={error} reset={reset} subject="feed health" where="src/routes/health.tsx" />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

const OWNS: Record<string, string> = {
  meta_ads: "Ad spend, impressions and clicks from every Meta ad account",
  zoom: "Webinar sessions, registrants and minute-by-minute attendance",
  ledger: "Money collected, from the accounts team's sheet",
  tm_payments: "TagMango payment records used to reconcile collections",
  tm_products: "The TagMango product catalogue that decides what counts as a sale",
  leads: "Registrations and their campaign attribution from the CRM",
};

/** ● collected · ◐ partial · ○ nothing — glyph first, lightness second. */
const GLYPH = { full: "\u25cf", partial: "\u25d0", none: "\u25cb" } as const;
const CELL_TONE = {
  full: "text-foreground",
  partial: "text-warning",
  none: "text-muted-foreground/45",
} as const;

function HealthPage() {
  const { data } = useSuspenseQuery(feedScreenQuery());
  const runSync = useServerFn(triggerSync);
  const untilToday = new Date().toISOString().slice(0, 10);

  async function onSync(payload?: { since: string; until: string }) {
    const result = await runSync({ data: payload ?? {} });
    if (result.status === "error") {
      throw new Error(result.error ?? "The sync did not finish.");
    }
    return `${result.status === "partial" ? "Partly synced" : "Sync complete"} · ${count(result.rowsWritten)} rows · ${result.since} → ${result.until}`;
  }
  const feeds = data.feeds;
  const byFeed = new Map<string, FeedStripRow[]>();
  for (const row of data.strip) {
    const list = byFeed.get(row.feed) ?? [];
    list.push(row);
    byFeed.set(row.feed, list);
  }

  return (
    <AppShell
      topBar={
        <div className="flex w-full items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-tight">Feed Health</h1>
          <span className="text-[11px] text-muted-foreground">
            {count(feeds.length)} feeds · {count(feeds.filter((f) => f.status === "live").length)}{" "}
            live
          </span>
          <div className="ml-auto">
            <DataMenu
              actions={[
                {
                  key: "sync",
                  label: "Sync Meta Ads",
                  description: "Pulls the recent days of figures for every active ad account.",
                  run: () => onSync(),
                },
                {
                  key: "backfill",
                  label: "Backfill from 1 January",
                  description: "Pulls every day of this year again for every active ad account.",
                  confirm: `Pull every day from 1 January to ${untilToday} again? This can run for several minutes.`,
                  run: () => onSync({ since: "2026-01-01", until: untilToday }),
                },
              ]}
            />
          </div>
        </div>
      }
    >
      <div className="px-6 py-5">
        {data.error ? (
          <UiError
            detail={data.error}
            subject="the feed health figures"
            where="src/routes/health.tsx"
            className="border-destructive/40 bg-destructive/10 mb-5 rounded-md border px-4 py-3"
          />
        ) : null}

        <BriefStatus />

        {feeds.some((f) => f.warning) ? (
          <div className="mb-5 space-y-2">
            {feeds
              .filter((f) => f.warning)
              .map((f) => (
                <div
                  key={`warn-${f.feed}`}
                  className={`rounded-md border px-4 py-2.5 text-xs ${
                    f.warning_level === "critical" ? TIER_PANEL.red : TIER_PANEL.amber
                  }`}
                >
                  {f.warning}
                </div>
              ))}
          </div>
        ) : null}

        <div className="border-border bg-card overflow-x-auto rounded-md border">
          <table className="w-full text-[12px]">
            <thead className="border-border bg-muted/60 border-b text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Feed</th>
                <th className="px-3 py-2 text-left font-medium">Owns</th>
                <th className="px-3 py-2 text-left font-medium">State</th>
                <th className="px-3 py-2 text-left font-medium">Last success</th>
                <th className="px-3 py-2 text-left font-medium">Data reaches</th>
                <th className="px-3 py-2 text-right font-medium">Rows last run</th>
              </tr>
            </thead>
            <tbody>
              {feeds.map((f) => (
                <FeedRow key={f.feed} feed={f} />
              ))}
            </tbody>
          </table>
        </div>

        <section className="mt-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Last 30 days
          </h2>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {GLYPH.full} collected · {GLYPH.partial} partial · {GLYPH.none} nothing. Oldest on the
            left.
          </p>
          <div className="border-border bg-card mt-2 space-y-1.5 overflow-x-auto rounded-md border p-3">
            {feeds.map((f) => {
              const days = (byFeed.get(f.feed) ?? [])
                .slice()
                .sort((a, b) => (a.date < b.date ? -1 : 1));
              return (
                <div key={`strip-${f.feed}`} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-[11px] text-muted-foreground">
                    {f.label}
                  </span>
                  <span className="nums flex gap-[3px] text-[13px] leading-none">
                    {Number(f.cadence_hours) > 24 ? (
                      <span className="text-[11px] text-muted-foreground">
                        arrives about every {Math.round(Number(f.cadence_hours) / 24)} days —{" "}
                        {days.filter((d) => d.state !== "none").length} arrival(s) in the last 30
                        days, a daily strip would read as empty
                      </span>
                    ) : days.length === 0 ? (
                      <span className="text-[11px] text-muted-foreground">no strip available</span>
                    ) : (
                      days.map((d) => (
                        <span
                          key={d.date}
                          className={CELL_TONE[d.state]}
                          title={`${d.date} — ${d.state === "full" ? `${d.rows_n} rows` : d.state === "partial" ? `${d.rows_n} rows, below a normal day` : "nothing collected"}`}
                        >
                          {GLYPH[d.state]}
                        </span>
                      ))
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <SafetyNetPanel />
      </div>
    </AppShell>
  );
}

function FeedRow({ feed }: { feed: FeedHealthRow }) {
  const { tier, note } = feedSeverity(feed);
  return (
    <tr className="border-border border-b last:border-b-0 align-top">
      <td className="px-3 py-2 font-medium">{feed.label}</td>
      <td className="max-w-[24rem] px-3 py-2 text-muted-foreground">{OWNS[feed.feed] ?? "—"}</td>
      <td className="px-3 py-2">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${FEED_TONE[feed.status]}`}
        >
          {feed.status}
        </span>
        {note ? (
          <p
            className={`mt-1 max-w-[26rem] whitespace-pre-wrap break-words text-[10px] leading-relaxed ${TIER_NOTE[tier]}`}
          >
            {note}
          </p>
        ) : null}
      </td>
      <td className="nums px-3 py-2 text-muted-foreground">
        {feedAgePhrase(feed.hours_since_success)}
      </td>
      <td className="nums px-3 py-2 text-muted-foreground">
        {feedAsAt(feed.coverage_edge) ?? "no rows at all"}
      </td>
      <td className="nums px-3 py-2 text-right text-muted-foreground">
        {feed.rows_last_run === null ? "—" : count(feed.rows_last_run)}
      </td>
    </tr>
  );
}

/** The morning brief has its own line here: written, failed, or not written yet. */
function BriefStatus() {
  const getBriefFn = useServerFn(getBrief);
  const { data } = useQuery({ queryKey: ["brief-health"], queryFn: () => getBriefFn() });
  if (!data?.configured) return null;

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const written = data.for_date === today && Boolean(data.brief);
  const failed = Boolean(data.failure?.error);

  return (
    <div
      className={`mb-5 rounded-md border px-4 py-2.5 text-xs ${
        failed
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : written
            ? "border-border bg-card text-muted-foreground"
            : "border-warning/40 bg-warning/10 text-warning"
      }`}
    >
      <span className="font-medium">Morning brief</span>{" "}
      {failed
        ? "— today's brief could not be written. It will be tried again on the next run."
        : written
          ? `— written for ${data.for_date}. It is prepared every morning at 12:00 noon India time, after the data syncs and the daily checks.`
          : `— not written for ${today} yet. It is prepared every morning at 12:00 noon India time, after the data syncs and the daily checks.`}
    </div>
  );
}

/**
 * Goldens: figures the owner has personally verified, re-derived from live code
 * every night. A red line here does not mean today's data is odd — it means the
 * code no longer reproduces a number that was already agreed to be true.
 */
