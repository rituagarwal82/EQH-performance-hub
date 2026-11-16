import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";

import { feedAgePhrase, feedAsAt, type FeedHealthRow } from "@/lib/feed-health";
import { feedSeverity, TIER_CHIP, TIER_RANK } from "@/lib/severity";

/**
 * Per-feed freshness, computed server-side in the same request as the data —
 * no `mounted` gate, so the first paint tells the truth. Six feeds, judged by
 * BOTH run age and how far the facts actually reach.
 */
export function FeedHealthStrip({ feeds }: { feeds: FeedHealthRow[] }) {
  if (feeds.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {feeds.map((f) => (
        <FeedChip key={f.feed} feed={f} />
      ))}
    </div>
  );
}

/**
 * One chip, not six. A top bar is read in a second, and six chips take longer
 * than that — so it states the single worst feed, which is the only one that
 * changes what you should do next. The full strip lives on /health.
 *
 * Severity is the three-tier language: red only for a feed that has actually
 * stopped, amber for behind-but-self-clearing, and nothing at all for known
 * structural notes. A known state must never read as an alarm.
 */
export function WorstFeedChip({ feeds }: { feeds: FeedHealthRow[] }) {
  // No feed rows means the health query itself could not be read. Silence here
  // would let the bar look clean during an outage, so it states the unknown.
  if (feeds.length === 0) {
    return (
      <Link
        to="/health"
        className="inline-flex shrink-0 items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-warning"
        title="Feed health could not be read — this is not a clean bill of health"
      >
        <AlertTriangle className="size-3" />
        feed status unknown
      </Link>
    );
  }

  const ranked = feeds
    .map((f) => ({ feed: f, tier: feedSeverity(f).tier }))
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
  const worst = ranked[0]!;
  const clean = worst.tier === "ok" || worst.tier === "info";
  const Icon = clean ? CheckCircle2 : worst.tier === "red" ? AlertTriangle : Clock;
  return (
    <Link
      to="/health"
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${TIER_CHIP[clean ? "ok" : worst.tier]}`}
      title={
        clean
          ? `All ${feeds.length} feeds collecting`
          : `${worst.feed.label}: ${worst.feed.status} — ${feedAgePhrase(worst.feed.hours_since_success)}`
      }
    >
      <Icon className="size-3" />
      {clean ? "all feeds live" : `${worst.feed.label} ${worst.feed.status}`}
    </Link>
  );
}

export function FeedChip({ feed }: { feed: FeedHealthRow }) {
  const at = feedAsAt(feed.coverage_edge);
  const { tier, note } = feedSeverity(feed);
  const Icon =
    tier === "ok" || tier === "info" ? CheckCircle2 : tier === "red" ? AlertTriangle : Clock;
  const detail =
    feed.status === "broken" && feed.running_since
      ? "a run has been in progress past twice its cadence — that is broken, not in progress"
      : note;

  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${TIER_CHIP[tier === "info" ? "ok" : tier]}`}
      title={[
        `${feed.label}: ${feed.status}`,
        feedAgePhrase(feed.hours_since_success),
        at ? `data reaches ${at}` : "no data rows at all",
        detail ?? "",
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <Icon className="size-3" />
      {feed.label}
      <span className="font-normal normal-case opacity-80">
        {feed.status === "live" ? (at ?? "live") : `${feed.status}${at ? ` · to ${at}` : ""}`}
      </span>
    </span>
  );
}

/** Blocking feed broken → the numbers are withheld, not greyed. */
export function WithheldPanel({ feeds }: { feeds: FeedHealthRow[] }) {
  if (feeds.length === 0) return null;
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/10 mb-5 rounded-md border px-4 py-3 text-xs text-destructive"
    >
      <div className="font-semibold uppercase tracking-wider">Figures withheld</div>
      <p className="mt-1 leading-relaxed">
        {feeds.map((f) => f.label).join(" and ")} {feeds.length === 1 ? "is" : "are"} broken, and
        every figure on this screen depends on {feeds.length === 1 ? "it" : "them"}. Nothing is
        shown until {feeds.length === 1 ? "it is" : "they are"} collecting again.
      </p>
      <ul className="mt-2 space-y-0.5">
        {feeds.map((f) => (
          <li key={f.feed}>
            {f.label} — {feedAgePhrase(f.hours_since_success)}
            {f.coverage_edge ? `, data reaches ${feedAsAt(f.coverage_edge)}` : ", no rows at all"}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The data arrived; something about the run is worth saying. Figures stay on
 * screen — the caution sits beside them rather than replacing them.
 */
export function FeedCautionPanel({ feeds }: { feeds: FeedHealthRow[] }) {
  if (feeds.length === 0) return null;
  return (
    <div className="border-warning/40 bg-warning/10 text-warning mb-5 rounded-md border px-4 py-3 text-xs">
      <div className="font-semibold uppercase tracking-wider">Worth knowing</div>
      <ul className="mt-1 space-y-0.5 leading-relaxed">
        {feeds.map((f) => {
          // A stopped feed says the same thing here as its chip does, and names
          // the action — never "wrote fewer rows than usual" beside "broken".
          const stopped = f.status === "broken" ? feedSeverity(f).note : null;
          return (
            <li key={f.feed}>
              {stopped
                ? `${f.label} — ${stopped}`
                : f.warning
                  ? `${f.label} — ${f.warning}`
                  : `${f.label} — the data reaches ${feedAsAt(f.coverage_edge) ?? "no date yet"}, so the very latest figures may still be incomplete.`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
