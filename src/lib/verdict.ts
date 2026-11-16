/**
 * The morning verdict.
 *
 * Nine candidate measures, five gates, one score. A verdict engine that can
 * surface anything surfaces noise, so the candidate set is closed and the
 * gates are structural: a modelled, unmeasured or suspect metric can never
 * reach a card, and neither can a move computed across an outage.
 */

import type { MetricFormat } from "@/components/MetricValue";
import type { MetricState } from "./metric";

export type MetricId =
  | "cost_per_registration"
  | "registrations"
  | "meta_spend"
  | "show_up_rate"
  | "retention_60"
  | "sales_per_1000_leads"
  | "cost_per_sale"
  | "front_end_roas"
  | "collected";

export type BadDirection = "up" | "down" | "either";

export type MetricDef = {
  id: MetricId;
  /** Plain English. Never an abbreviation, never a metric-speak noun phrase. */
  label: string;
  format: MetricFormat;
  bad: BadDirection;
  /** Rates need a denominator of at least 30 to mean anything. */
  isRate: boolean;
  feeds: string[];
  /** Where the action button goes. */
  drill: { to: string; label: string };
};

export const METRIC_DEFS: MetricDef[] = [
  {
    id: "cost_per_registration",
    label: "Cost per registration",
    format: "inr",
    bad: "up",
    isRate: true,
    feeds: ["meta_ads"],
    drill: { to: "/ads", label: "Open spend by account" },
  },
  {
    id: "registrations",
    label: "Registrations",
    format: "int",
    bad: "down",
    isRate: false,
    feeds: ["meta_ads"],
    drill: { to: "/ads", label: "Open spend by account" },
  },
  {
    id: "meta_spend",
    label: "Meta spend",
    format: "inr",
    bad: "either",
    isRate: false,
    feeds: ["meta_ads"],
    drill: { to: "/ads", label: "Open spend by account" },
  },
  {
    id: "show_up_rate",
    label: "Show-up rate",
    format: "percent",
    bad: "down",
    isRate: true,
    feeds: ["zoom"],
    drill: { to: "/show-up", label: "Open show-up" },
  },
  {
    id: "retention_60",
    label: "Still watching at 60 minutes",
    format: "percent",
    bad: "down",
    isRate: true,
    feeds: ["zoom"],
    drill: { to: "/show-up", label: "Open show-up" },
  },
  {
    id: "sales_per_1000_leads",
    label: "Sales per 1,000 registrations",
    format: "decimal",
    bad: "down",
    isRate: true,
    feeds: ["meta_ads", "ledger"],
    drill: { to: "/sales", label: "Open collections" },
  },
  {
    id: "cost_per_sale",
    label: "Cost per sale",
    format: "inr",
    bad: "up",
    isRate: true,
    feeds: ["meta_ads", "ledger"],
    drill: { to: "/sales", label: "Open collections" },
  },
  {
    id: "front_end_roas",
    label: "Paid front-end ROAS (ex-GST)",
    format: "ratio",
    bad: "down",
    isRate: false,
    feeds: ["meta_ads", "ledger"],
    drill: { to: "/sales", label: "Open collections" },
  },
  {
    id: "collected",
    label: "Collected",
    format: "inr",
    bad: "down",
    isRate: false,
    feeds: ["ledger"],
    drill: { to: "/sales", label: "Open collections" },
  },
];

export const METRIC_BY_ID: Record<string, MetricDef> = Object.fromEntries(
  METRIC_DEFS.map((d) => [d.id, d]),
);

export type SeriesPoint = {
  period_start: string;
  metric_id: string;
  value: number | string | null;
  denom: number | string | null;
  rupees: number | string | null;
  complete: boolean;
};

export type BaselineRow = {
  metric_id: string;
  grain: string;
  weekday_class: string;
  median: number | string | null;
  mad: number | string | null;
  n_observations: number;
};

export type HistoryRow = { date: string; metric_id: string; z: number | string };

export type Candidate = {
  id: MetricId;
  label: string;
  format: MetricFormat;
  value: number | null;
  state: MetricState;
  baseline: number | null;
  sigma: number | null;
  bandLow: number | null;
  bandHigh: number | null;
  z: number | null;
  direction: "up" | "down" | "flat";
  unfavourable: boolean;
  rupees: number;
  denom: number | null;
  rank: number;
  /** 14 points, oldest first. Nulls preserved — a gap is a gap. */
  spark: { date: string; value: number | null }[];
  /** Consecutive days already outside the band, including today. */
  streak: number;
  /** Rank within the 18-day trailing window, 1 = most extreme. */
  extremity: number | null;
  extremityWindow: number;
  /** Null when eligible; otherwise the gate that stopped it. */
  blockedBy: string | null;
  drill: { to: string; label: string };
};

export type Verdict = {
  asof: string | null;
  /** Every candidate, gated and scored — the holding line reads from this. */
  candidates: Candidate[];
  flagged: Candidate[];
  holding: Candidate[];
  notMeasured: Candidate[];
  /** On an all-clear day, the eligible measure sitting closest to its edge. */
  closest: Candidate | null;
  checked: number;
};

const num = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const MIN_OBSERVATIONS = 8;
const MIN_DENOM = 30;
const MIN_RUPEES = 25_000;
const Z_THRESHOLD = 2.0;
const Z_OVERRIDE = 3.0;

/** Sigma floors, per metric, in the metric's own unit. Without them a quiet
 *  fortnight produces a MAD near zero and every ripple reads as 40σ. */
const SIGMA_FLOOR: Record<MetricId, number> = {
  cost_per_registration: 10,
  registrations: 5,
  meta_spend: 1000,
  show_up_rate: 1.5,
  retention_60: 1.5,
  sales_per_1000_leads: 3,
  cost_per_sale: 250,
  front_end_roas: 0.04,
  collected: 3000,
};

export function weekdayClass(date: string): "weekday" | "weekend" {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6 ? "weekend" : "weekday";
}

export function buildVerdict(input: {
  asof: string | null;
  series: SeriesPoint[];
  baselines: BaselineRow[];
  feedStatus: Record<string, string>;
  history: HistoryRow[];
  /** 18-day window used only to describe extremity. */
  extremitySeries: SeriesPoint[];
}): Verdict {
  const { asof } = input;
  if (!asof) {
    return {
      asof: null,
      candidates: [],
      flagged: [],
      holding: [],
      notMeasured: [],
      closest: null,
      checked: 0,
    };
  }

  const wc = weekdayClass(asof);
  const byMetric = new Map<string, SeriesPoint[]>();
  for (const p of input.series) {
    const list = byMetric.get(p.metric_id);
    if (list) list.push(p);
    else byMetric.set(p.metric_id, [p]);
  }

  const yesterdayIso = shiftDays(asof, -1);
  const historyByMetric = new Map<string, string[]>();
  for (const h of input.history) {
    const list = historyByMetric.get(h.metric_id);
    const d = String(h.date).slice(0, 10);
    if (list) list.push(d);
    else historyByMetric.set(h.metric_id, [d]);
  }

  const candidates: Candidate[] = METRIC_DEFS.map((def) => {
    const points = (byMetric.get(def.id) ?? []).sort((a, b) =>
      a.period_start < b.period_start ? -1 : 1,
    );
    const today = points.find((p) => String(p.period_start).slice(0, 10) === asof);
    const value = num(today?.value);
    const denom = num(today?.denom);
    const rupees = num(today?.rupees) ?? 0;
    const complete = Boolean(today?.complete);

    const spark = points.slice(-14).map((p) => ({
      date: String(p.period_start).slice(0, 10),
      value: num(p.value),
    }));

    const base = input.baselines.find(
      (b) => b.metric_id === def.id && b.grain === "day" && b.weekday_class === wc,
    );
    const baseline = num(base?.median ?? null);
    const mad = num(base?.mad ?? null);
    const sigmaRaw = mad === null ? null : mad * 1.4826;
    const sigma = sigmaRaw === null ? null : Math.max(sigmaRaw, SIGMA_FLOOR[def.id]);

    // ── state ──
    let state: MetricState = "measured";
    if (value === null) state = "unmeasured";
    else if (def.isRate && def.format === "percent" && value > 100) state = "suspect";
    else if (!complete) state = "partial";

    const z = value !== null && baseline !== null && sigma ? (value - baseline) / sigma : null;
    const direction: "up" | "down" | "flat" =
      z === null || Math.abs(z) < 0.0001 ? "flat" : z > 0 ? "up" : "down";
    const unfavourable = def.bad === "either" ? direction !== "flat" : direction === def.bad;

    // ── gates ──
    let blockedBy: string | null = null;
    if (state !== "measured" && state !== "partial")
      blockedBy = `G1 — this measure is ${state}, and only a measured or partial figure can be flagged`;
    else if (def.isRate && (denom === null || denom < MIN_DENOM))
      blockedBy = `G2 — ${denom === null ? "no" : denom} in the denominator, below the ${MIN_DENOM} a rate needs`;
    else {
      const badFeed = def.feeds.find((f) => {
        const s = input.feedStatus[f];
        return s !== "live" && s !== "late";
      });
      if (badFeed)
        blockedBy = `G3 — the ${badFeed} feed is ${input.feedStatus[badFeed] ?? "unknown"}`;
      else if (!complete || !base || base.n_observations < MIN_OBSERVATIONS)
        blockedBy = !complete
          ? "G4 — this day was not fully collected, so a move cannot be told apart from an outage"
          : `G4 — the normal range rests on ${base ? base.n_observations : 0} observations, below the ${MIN_OBSERVATIONS} needed`;
      else if (rupees < MIN_RUPEES)
        blockedBy = `G5 — only ₹${Math.round(rupees).toLocaleString("en-IN")} sits behind this`;
    }

    // ── persistence and cooldown ──
    const flaggedDates = historyByMetric.get(def.id) ?? [];
    let streak = 0;
    let cursor = yesterdayIso;
    while (flaggedDates.includes(cursor)) {
      streak += 1;
      cursor = shiftDays(cursor, -1);
    }
    const recentlyFlagged = [1, 2, 3].some((n) => flaggedDates.includes(shiftDays(asof, -n)));
    const inCooldown = recentlyFlagged && streak === 0;

    // ── extremity, purely descriptive ──
    const window = input.extremitySeries
      .filter((p) => p.metric_id === def.id)
      .map((p) => num(p.value))
      .filter((v): v is number => v !== null);
    const extremity =
      value === null || window.length === 0
        ? null
        : def.bad === "down"
          ? window.filter((v) => v < value).length + 1
          : window.filter((v) => v > value).length + 1;

    let rank = 0;
    if (!blockedBy && z !== null && Math.abs(z) >= Z_THRESHOLD && unfavourable) {
      if (!inCooldown || Math.abs(z) >= Z_OVERRIDE) {
        rank = Math.abs(z) * Math.log10(1 + Math.max(0, rupees));
        if (streak > 0) rank *= 1.15;
      } else {
        blockedBy = "cooldown — this returned inside its band within the last 3 days";
      }
    }

    return {
      id: def.id,
      label: def.label,
      format: def.format,
      value,
      state,
      baseline,
      sigma,
      bandLow: baseline !== null && sigma !== null ? baseline - sigma : null,
      bandHigh: baseline !== null && sigma !== null ? baseline + sigma : null,
      z,
      direction,
      unfavourable,
      rupees,
      denom,
      rank,
      spark,
      streak: streak + (rank > 0 ? 1 : 0),
      extremity,
      extremityWindow: window.length,
      blockedBy,
      drill: def.drill,
    };
  });

  const flagged = candidates
    .filter((c) => c.rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 3);
  const flaggedIds = new Set(flagged.map((c) => c.id));

  const eligible = candidates.filter((c) => c.blockedBy === null && !flaggedIds.has(c.id));
  const notMeasured = candidates.filter(
    (c) => c.value === null || c.state === "unmeasured" || c.state === "suspect",
  );
  const holding = eligible.filter((c) => c.value !== null);

  const closest = [...eligible]
    .filter((c) => c.z !== null)
    .sort((a, b) => Math.abs(b.z as number) - Math.abs(a.z as number))[0];

  return {
    asof,
    candidates,
    flagged,
    holding,
    notMeasured,
    closest: closest ?? null,
    // "Checked" means TESTED AGAINST ITS BAND — not "considered". A measure
    // thrown out by a gate was never checked, and counting it here is how a
    // zero-check day came to be reported as an all-clear.
    checked: flagged.length + holding.length,
  };
}

export function shiftDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/** "Saturday 30 August" — day names, because a date alone is not a read. */
export function longDay(iso: string | null): string {
  if (!iso) return "an unknown day";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}
