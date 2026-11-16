import { createServerFn } from "@tanstack/react-start";

import type { FeedHealthRow } from "./feed-health.functions";
import type { BaselineRow, HistoryRow, SeriesPoint, Verdict } from "./verdict";

export type VerdictData = {
  configured: boolean;
  verdict: Verdict;
  feeds: FeedHealthRow[];
  /**
   * The plain-prose sentence's raw ingredients, for the day being shown.
   *
   * `sales` is the TagMango enrolment count — timely and complete, coupon
   * enrolments included. `collected` is the accounts ledger and only the
   * ledger; while `collectedSettling` is true the ledger for that day is
   * still being typed and the figure is a floor, never the day's revenue.
   */
  sentence: {
    spend: number | null;
    registrations: number | null;
    costPerRegistration: number | null;
    sales: number | null;
    ledgerSales: number | null;
    collected: number | null;
    collectedSettling: boolean;
  };
  baselineComputedAt: string | null;
  baselineThinness: { metric_id: string; n: number }[];
  error: string | null;
};

const EMPTY: VerdictData = {
  configured: false,
  verdict: {
    asof: null,
    candidates: [],
    flagged: [],
    holding: [],
    notMeasured: [],
    closest: null,
    checked: 0,
  },
  feeds: [],
  sentence: {
    spend: null,
    registrations: null,
    costPerRegistration: null,
    sales: null,
    ledgerSales: null,
    collected: null,
    collectedSettling: false,
  },
  baselineComputedAt: null,
  baselineThinness: [],
  error: null,
};

export async function readVerdict(): Promise<VerdictData> {
  const { getPg, pgRpc, pgSelect } = await import("./pg.server");
  const { readFeedHealth } = await import("./feed-health.functions");
  const { buildVerdict, shiftDays } = await import("./verdict");

  const pg = getPg();
  if (!pg) return EMPTY;

  try {
    const health = await readFeedHealth();
    const feeds = health.feeds;
    const feedStatus: Record<string, string> = {};
    for (const f of feeds) feedStatus[f.feed] = f.status;

    // The day being read is the furthest day the blocking feeds reached, never
    // beyond yesterday. Taking the EARLIEST edge let one lagging feed freeze
    // the whole screen (and the brief) on a stale date.
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const edges = feeds
      .filter((f) => f.is_blocking)
      .map((f) => f.coverage_edge)
      .filter((d): d is string => Boolean(d))
      .map((d) => d.slice(0, 10))
      .sort();
    const maxEdge = edges.length > 0 ? edges[edges.length - 1]! : null;
    const asof = maxEdge ? (maxEdge > yesterday ? yesterday : maxEdge) : null;


    if (!asof) {
      return { ...EMPTY, configured: true, feeds };
    }

    const [series, extremitySeries, baselines, history, components] = await Promise.all([
      pgRpc<SeriesPoint[]>(pg, "metric_series", {
        p_start: shiftDays(asof, -13),
        p_end: asof,
        p_grain: "day",
      }),
      pgRpc<SeriesPoint[]>(pg, "metric_series", {
        p_start: shiftDays(asof, -17),
        p_end: asof,
        p_grain: "day",
      }),
      pgSelect<BaselineRow[]>(
        pg,
        "/metric_baselines?select=metric_id,grain,weekday_class,median,mad,n_observations,computed_at&grain=eq.day",
      ),
      pgSelect<HistoryRow[]>(
        pg,
        `/verdict_history?select=date,metric_id,z&date=gte.${shiftDays(asof, -6)}`,
      ),
      pgRpc<
        {
          date: string;
          spend: number | string | null;
          measured_spend: number | string | null;
          registrations: number | string | null;
          sales: number | string | null;
          tm_sales: number | string | null;
          ledger_sales: number | string | null;
          ledger_settling: boolean | null;
          collected: number | string | null;
        }[]
      >(pg, "metric_components", { p_start: asof, p_end: asof }),
    ]);

    const verdict = buildVerdict({
      asof,
      series: series ?? [],
      extremitySeries: extremitySeries ?? [],
      baselines: baselines ?? [],
      feedStatus,
      history: history ?? [],
    });

    const c = components?.[0];
    const n = (v: number | string | null | undefined) => {
      if (v === null || v === undefined || v === "") return null;
      const x = Number(v);
      return Number.isFinite(x) ? x : null;
    };
    const regs = n(c?.registrations);
    const mspend = n(c?.measured_spend);

    // Persist today's selection so tomorrow can say "second day above the band".
    if (verdict.flagged.length > 0) {
      const { pgUpsert } = await import("./pg.server");
      await pgUpsert(
        pg,
        "verdict_history",
        verdict.flagged.map((f, i) => ({
          date: asof,
          metric_id: f.id,
          z: f.z,
          rupees: Math.round(f.rupees),
          rank: f.rank,
          position: i + 1,
          value: f.value,
          baseline: f.baseline,
          direction: f.direction,
        })),
      );
    }

    const computedAt = (baselines ?? []).reduce<string | null>((acc, b) => {
      const t = (b as unknown as { computed_at?: string }).computed_at ?? null;
      return t && (!acc || t > acc) ? t : acc;
    }, null);

    return {
      configured: true,
      verdict,
      feeds,
      sentence: {
        spend: n(c?.spend),
        registrations: regs,
        costPerRegistration: regs && mspend !== null && regs > 0 ? mspend / regs : null,
        sales: n(c?.tm_sales) ?? n(c?.sales),
        ledgerSales: n(c?.ledger_sales),
        collected: n(c?.collected),
        collectedSettling: c?.ledger_settling === true,
      },
      baselineComputedAt: computedAt,
      baselineThinness: (baselines ?? [])
        .filter((b) => b.n_observations < 8)
        .map((b) => ({ metric_id: b.metric_id, n: b.n_observations })),
      error: null,
    };
  } catch (error) {
    return {
      ...EMPTY,
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const getVerdict = createServerFn({ method: "GET" }).handler(readVerdict);

export type FeedStripRow = {
  feed: string;
  date: string;
  rows_n: number | string;
  state: "full" | "partial" | "none";
};

export const getFeedScreen = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    configured: boolean;
    feeds: FeedHealthRow[];
    strip: FeedStripRow[];
    error: string | null;
  }> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const { readFeedHealth } = await import("./feed-health.functions");
    const pg = getPg();
    if (!pg) return { configured: false, feeds: [], strip: [], error: null };
    try {
      const [health, strip] = await Promise.all([
        readFeedHealth(),
        pgRpc<FeedStripRow[]>(pg, "feed_day_strip", { p_days: 30 }),
      ]);
      return { configured: true, feeds: health.feeds, strip: strip ?? [], error: health.error };
    } catch (error) {
      return {
        configured: true,
        feeds: [],
        strip: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
);

