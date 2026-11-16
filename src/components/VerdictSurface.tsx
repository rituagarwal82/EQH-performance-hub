import { Link } from "@tanstack/react-router";
import { ArrowRight, Check, TriangleAlert } from "lucide-react";

import { ChecksCouldNotRun } from "@/components/DataOutage";
import { MetricValue, renderMetric } from "@/components/MetricValue";

import { Sparkline } from "@/components/Sparkline";
import { Button } from "@/components/ui/button";
import { count, inrText } from "@/lib/counts";
import type { FeedHealthRow } from "@/lib/feed-health";
import type { Metric } from "@/lib/metric";
import { longDay, type Candidate, type Verdict } from "@/lib/verdict";

function metricOf(c: Candidate): Metric {
  return c.value === null
    ? { value: null, state: "unmeasured" }
    : { value: c.value, state: c.state };
}

function ordinal(n: number): string {
  const names = ["", "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh"];
  return names[n] ?? `${n}th`;
}

/** a) The coverage line. Always first, even when boring. */
export function VerdictCoverageLine({
  asof,
  today,
  perforated,
}: {
  asof: string | null;
  today: string;
  perforated: string[];
}) {
  return (
    <p className="text-[13px] text-muted-foreground">
      <span className="font-medium text-foreground">{longDay(today)}</span> · showing{" "}
      <span className="font-medium text-foreground">{longDay(asof)}</span> ·{" "}
      {perforated.length === 0 ? (
        "everything collected"
      ) : (
        <span className="text-warning">
          {count(perforated.length)} earlier day
          {perforated.length === 1 ? "" : "s"} in the last fortnight not collected
        </span>
      )}
    </p>
  );
}

/** b) The sentence. Two lines of prose, no tiles, no abbreviations. */
export function VerdictSentence({
  asof,
  sentence,
}: {
  asof: string | null;
  sentence: {
    spend: number | null;
    registrations: number | null;
    costPerRegistration: number | null;
    sales: number | null;
    ledgerSales?: number | null;
    collected: number | null;
    collectedSettling?: boolean;
  };
}) {
  // Day resolution failed: there is no honest sentence to write about an
  // unknown day, so the caller's outage banner speaks instead of this.
  if (!asof) return null;
  const { spend, registrations, costPerRegistration, sales, collected } = sentence;
  const settling = sentence.collectedSettling === true;
  const first =
    spend === null
      ? `We have no spend figure for ${longDay(asof)}.`
      : registrations === null || costPerRegistration === null
        ? `${longDay(asof)} cost you ${inrText(spend)}. Registrations were not measured that day.`
        : `${longDay(asof)} cost you ${inrText(spend)} and returned ${count(registrations)} registration${registrations === 1 ? "" : "s"} at ${inrText(costPerRegistration)} each.`;
  // The count is TagMango enrolments — real-time and complete, coupon
  // enrolments included. The money is the accounts ledger, hand-entered 1–2
  // days behind, so a settling day is never presented as the day's revenue.
  const money =
    collected === null
      ? "nothing has been entered in the ledger yet"
      : `${inrText(collected)} entered in the ledger so far`;
  const lag = settling ? " — collections usually land 1–2 days later" : "";
  const second =
    sales === null
      ? collected === null
        ? "No L1 sales have been recorded against that day."
        : `${inrText(collected)} has been entered in the ledger against that day.`
      : `${count(sales)} L1 sale${sales === 1 ? "" : "s"} came in (TagMango); ${money}${lag}.`;

  return (
    <p className="mt-2 max-w-3xl text-[17px] leading-relaxed">
      {first} {second}
    </p>
  );
}

/** c) Needs attention: 0–3 cards, never padded. */
export function AttentionCards({ flagged }: { flagged: Candidate[] }) {
  if (flagged.length === 0) return null;
  return (
    <section className="mt-5">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Needs attention
      </h2>
      <div className="mt-2 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {flagged.map((c) => (
          <AttentionCard key={c.id} c={c} />
        ))}
      </div>
    </section>
  );
}

function AttentionCard({ c }: { c: Candidate }) {
  const up = c.direction === "up";
  const glyph = up ? "\u25b2" : "\u25bc";
  const because: string[] = [];

  if (c.extremity === 1) {
    because.push(`${up ? "Highest" : "Lowest"} in ${count(c.extremityWindow)} days.`);
  } else if (c.extremity !== null && c.extremity <= 3) {
    because.push(
      `${ordinal(c.extremity)} ${up ? "highest" : "lowest"} in ${count(c.extremityWindow)} days.`,
    );
  }
  if (c.bandLow !== null && c.bandHigh !== null) {
    because.push(
      `Normal range ${renderMetric(c.bandLow, c.format)}\u2013${renderMetric(c.bandHigh, c.format)}.`,
    );
  }
  because.push(`${inrText(Math.round(c.rupees))} behind this.`);
  if (c.streak > 1) {
    because.push(`${ordinal(c.streak)} day ${up ? "above" : "below"} the band.`);
  }

  return (
    <article className="border-border bg-card rounded-md border p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[13px] font-semibold">{c.label}</h3>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {c.z === null
            ? ""
            : Math.abs(c.z) >= 3
              ? "far outside normal"
              : "outside normal"}
        </span>
      </div>

      <div className="nums mt-1 flex items-baseline gap-2">
        <span className="text-2xl leading-none">
          <MetricValue metric={metricOf(c)} format={c.format} emphasis />
        </span>
        <span className="text-[12px] text-muted-foreground">
          {glyph} from {c.baseline === null ? "no baseline" : renderMetric(c.baseline, c.format)}
        </span>
      </div>

      <div className="mt-3">
        <Sparkline points={c.spark} format={c.format} bandLow={c.bandLow} bandHigh={c.bandHigh} />
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">{because.join(" ")}</p>

      <Button asChild size="sm" variant="outline" className="mt-3 h-7 gap-1.5 text-xs">
        <Link to={c.drill.to} search={{ range: "last14", compare: false }}>
          {c.drill.label}
          <ArrowRight className="size-3.5" />
        </Link>
      </Button>
    </article>
  );
}

/**
 * The all-clear day. States the count checked, names the closest to the edge.
 *
 * Refuses to render green when nothing was actually checked — a zero-check
 * all-clear is the worst degradation state this product can show.
 */
export function AllClear({ verdict }: { verdict: Verdict }) {
  const closest = verdict.closest;
  // Green requires measures that actually passed the gates AND sat inside
  // their band. Nothing tested is never an all-clear.
  if (verdict.asof === null || verdict.holding.length === 0) {
    return (
      <ChecksCouldNotRun
        reason={
          verdict.asof === null
            ? "the day being measured could not be resolved"
            : "no measure had enough data to test"
        }
      />
    );
  }
  return (
    <section className="border-positive/30 bg-positive/10 mt-5 rounded-md border px-4 py-3">
      <div className="text-positive flex items-center gap-2 text-[13px] font-semibold">
        <Check className="size-4" />
        Nothing is outside its normal range today.
      </div>
      <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
        {count(verdict.checked)} measures were tested against their usual range, and all{" "}
        {count(verdict.holding.length)} sat inside it.
        {closest && closest.value !== null && closest.bandLow !== null && closest.bandHigh !== null
          ? ` Closest to the edge: ${closest.label.toLowerCase()} at ${renderMetric(closest.value, closest.format)} against a normal range of ${renderMetric(closest.bandLow, closest.format)}\u2013${renderMetric(closest.bandHigh, closest.format)}.`
          : ""}
      </p>
    </section>
  );
}

/** d) Holding — proof that "nothing flagged" is not "we forgot to check". */
export function HoldingLine({ holding }: { holding: Candidate[] }) {
  if (holding.length === 0) return null;
  return (
    <p className="border-border bg-card mt-3 rounded-md border px-4 py-2 text-[12px] leading-relaxed">
      <span className="font-semibold uppercase tracking-wider text-muted-foreground">Holding</span>{" "}
      — {count(holding.length)} measures inside their normal range:{" "}
      {holding.map((c, i) => (
        <span key={c.id} className="text-muted-foreground">
          {i > 0 ? " · " : ""}
          {c.label}{" "}
          <span className="nums text-foreground">
            {c.value === null ? "—" : renderMetric(c.value, c.format)}
          </span>
        </span>
      ))}
    </p>
  );
}

/** e) Not measured — count and names, linking to the trust screen. */
export function NotMeasuredLine({ candidates }: { candidates: Candidate[] }) {
  if (candidates.length === 0) return null;
  return (
    <p className="mt-2 text-[12px] text-muted-foreground">
      <span className="font-semibold uppercase tracking-wider">Not measured</span> —{" "}
      {count(candidates.length)}: {candidates.map((c) => c.label).join(" · ")}.{" "}
      <Link to="/trust" search={{ range: "last30", compare: false }} className="underline">
        Why
      </Link>
    </p>
  );
}

/** 5) Meta connection expiry, sitting beside attention rather than inside it. */
export function TokenExpiryNotice({ feeds }: { feeds: FeedHealthRow[] }) {
  const meta = feeds.find((f) => f.warning);
  if (!meta?.warning) return null;
  const critical = meta.warning_level === "critical";
  return (
    <div
      role="note"
      className={`mt-3 flex items-start gap-2 rounded-md border px-4 py-2.5 text-[12px] ${
        critical
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-warning/40 bg-warning/10 text-warning"
      }`}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{meta.warning}</span>
    </div>
  );
}
