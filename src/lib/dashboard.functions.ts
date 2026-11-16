import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type {
  AccountRollupRow,
  BreakEvenInputs,
  DailySpendRow,
  EntityRollupRow,
  MeasuredAscension,
  OverviewData,
  PaidDailyRow,
  SyncRunRow,
  SyncSummary,
} from "./dashboard-types";
import { safeMessage } from "./safe-error";

const rangeInput = z.object({
  since: z.string(),
  until: z.string(),
});

const SETTING_KEYS = [
  "breakeven_l1_price",
  "breakeven_backend_price",
  "breakeven_ascension_rate",
  "breakeven_buyers_per_1000",
] as const;

type SettingRow = { key: string; value: string | null; description: string | null };

function toBreakEven(rows: SettingRow[]): BreakEvenInputs {
  const get = (k: string) => rows.find((r) => r.key === k);
  const num = (k: string, fallback: number) => {
    const v = Number(get(k)?.value);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    l1Price: num("breakeven_l1_price", 0),
    backendPrice: num("breakeven_backend_price", 230000),
    ascensionRate: num("breakeven_ascension_rate", 21.5),
    buyersPer1000: num("breakeven_buyers_per_1000", 0),
    buyersPer1000Note: get("breakeven_buyers_per_1000")?.description ?? null,
  };
}

export const getOverview = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => rangeInput.parse(data))
  .handler(async ({ data }): Promise<OverviewData> => {
    const { getPg, pgRpc, pgSelect, errorForUi } = await import("./pg.server");
    const { normaliseCoverage, priorOfClipped, resolveCoveredRange } = await import("./coverage");
    const { readFeedHealth } = await import("./feed-health.functions");
    const { timedQuery } = await import("./query-timing.server");
    const { NO_SECTION_ERRORS, allSectionsFailed } = await import("./dashboard-types");
    const pg = getPg();
    const requested = { since: data.since, until: data.until };
    const emptyBreakEven: BreakEvenInputs = {
      // Never an assumed price: the realised average from the ledger is used,
      // and where there is none the ceiling is simply not produced.
      l1Price: 0,
      backendPrice: 230000,
      ascensionRate: 21.5,
      buyersPer1000: 0,
      buyersPer1000Note: null,
    };

    if (!pg) {
      return {
        configured: false,
        requested,
        range: requested,
        prior: requested,
        coverage: null,
        regimes: [],

        feeds: [],
        accounts: [],
        priorAccounts: [],
        series: [],
        lastRun: null,
        breakEven: emptyBreakEven,
        ascension: null,
        frontEnd: null,
        paidFrontEnd: null,
        error: null,
        sections: { ...NO_SECTION_ERRORS },
      };
    }

    try {
      // 1. What was actually collected inside the requested window.
      const coverageRows = await pgRpc<import("./coverage").DayCoverageRow[]>(
        pg,
        "daily_coverage",
        { p_start: requested.since, p_end: requested.until },
      );
      const coverage = resolveCoveredRange(requested, normaliseCoverage(coverageRows ?? []), [
        "meta",
      ]);
      const range = coverage.range;
      // 2. The prior window is the same length as the CLIPPED window, never the
      //    requested one — that arithmetic is what invented a −41.6% collapse.
      const prior = priorOfClipped(coverage);

      // 2b. Days a team stopped buying. A window that straddles one is not
      //     comparing the same business against itself, and must say so.
      let regimes: import("./regime").RegimeBoundary[] = [];
      try {
        regimes =
          (await pgRpc<import("./regime").RegimeBoundary[]>(pg, "regime_boundaries", {
            p_start: prior.since,
            p_end: range.until,
          })) ?? [];
      } catch (e) {
        console.error("[EQH] regime boundaries unread:", safeMessage(e));
      }



      // 3. P0-A: allSettled, never all. One slow RPC used to empty accounts,
      //    series AND feeds at once — that is how the owner saw an outage
      //    banner above a working sparkline and "0 of 0 accounts".
      const settled = await timedQuery("overview", () =>
        Promise.allSettled([
          pgRpc<AccountRollupRow[]>(pg, "account_month_rollup", {
            p_start: range.since,
            p_end: range.until,
          }),
          pgRpc<AccountRollupRow[]>(pg, "account_month_rollup", {
            p_start: prior.since,
            p_end: prior.until,
          }),
          pgRpc<DailySpendRow[]>(pg, "daily_spend_series", {
            p_start: range.since,
            p_end: range.until,
          }),
          pgSelect<SyncRunRow[]>(
            pg,
            "/sync_runs?select=started_at,finished_at,status,rows_written,error,source&order=started_at.desc&limit=1",
          ),
          pgSelect<SettingRow[]>(
            pg,
            `/app_settings?select=key,value,description&key=in.(${SETTING_KEYS.join(",")})`,
          ),
          readFeedHealth(),
          pgRpc<MeasuredAscension[]>(pg, "measured_ascension", {}),
          pgRpc<{ business_date: string; sales: number | string; collected: number | string }[]>(
            pg,
            "ledger_daily",
            { p_start: range.since, p_end: range.until, p_tier: "L1_SILVER" },
          ),
          pgRpc<PaidDailyRow[]>(pg, "ledger_paid_daily", {
            p_start: range.since,
            p_end: range.until,
          }),
        ]),
      );

      const sections = { ...NO_SECTION_ERRORS };
      function take<T>(i: number, key: keyof typeof sections): T | null {
        const r = settled[i]!;
        if (r.status === "fulfilled") return (r.value ?? null) as T | null;
        const detail = errorForUi(r.reason);
        sections[key] = detail.kind;
        console.error(`[EQH] overview section ${key} failed:`, detail.raw);
        return null;
      }

      const accounts = take<AccountRollupRow[]>(0, "accounts");
      const priorAccounts = take<AccountRollupRow[]>(1, "priorAccounts");
      const series = take<DailySpendRow[]>(2, "series");
      const runs = take<SyncRunRow[]>(3, "lastRun");
      const settings = take<SettingRow[]>(4, "settings");
      const feedHealth = take<Awaited<ReturnType<typeof readFeedHealth>>>(5, "feeds");
      const ascension = take<MeasuredAscension[]>(6, "ascension");
      const ledgerDaily =
        take<{ business_date: string; sales: number | string; collected: number | string }[]>(
          7,
          "ledger",
        );
      const paidDaily = take<PaidDailyRow[]>(8, "paidLedger");

      // Front-end collections over the SAME clipped window, so the ceiling can
      // never be read apart from the ROAS actually being achieved.
      const paid = (paidDaily ?? []).reduce(
        (acc, r) => ({
          all: acc.all + (Number(r.collected_all) || 0),
          noLead: acc.noLead + (Number(r.collected_no_lead) || 0),
          instalment: acc.instalment + (Number(r.collected_instalment) || 0),
          paidGross: acc.paidGross + (Number(r.collected_paid_gross) || 0),
          paidExGst: acc.paidExGst + (Number(r.collected_paid_exgst) || 0),
          unsyncedGross: acc.unsyncedGross + (Number(r.collected_unsynced_gross) || 0),
          unsyncedRows: acc.unsyncedRows + (Number(r.rows_unsynced) || 0),
        }),
        {
          all: 0,
          noLead: 0,
          instalment: 0,
          paidGross: 0,
          paidExGst: 0,
          unsyncedGross: 0,
          unsyncedRows: 0,
        },
      );

      const frontEnd = (ledgerDaily ?? []).reduce(
        (acc, r) => ({
          sales: acc.sales + (Number(r.sales) || 0),
          collected: acc.collected + (Number(r.collected) || 0),
          days: acc.days + 1,
        }),
        { sales: 0, collected: 0, days: 0 },
      );

      return {
        configured: true,
        requested,
        range,
        prior,
        coverage,
        regimes: regimes ?? [],

        feeds: feedHealth?.feeds ?? [],
        accounts: accounts ?? [],
        priorAccounts: priorAccounts ?? [],
        series: series ?? [],
        lastRun: runs?.[0] ?? null,
        breakEven: toBreakEven(settings ?? []),
        ascension: ascension?.[0] ?? null,
        frontEnd: sections.ledger === null && frontEnd.days > 0 ? frontEnd : null,
        paidFrontEnd: sections.paidLedger === null && (paidDaily ?? []).length > 0 ? paid : null,
        error: null,
        sections,
      };
    } catch (e) {
      const detail = errorForUi(e);
      console.error("[EQH] overview read failed:", detail.raw);
      return {
        configured: true,
        requested,
        range: requested,
        prior: requested,
        coverage: null,
        regimes: [],

        feeds: [],
        accounts: [],
        priorAccounts: [],
        series: [],
        lastRun: null,
        breakEven: emptyBreakEven,
        ascension: null,
        frontEnd: null,
        paidFrontEnd: null,
        error: detail.kind,
        sections: allSectionsFailed(detail.kind),
      };
    }
  });


export const getEntityRollup = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    z
      .object({
        since: z.string(),
        until: z.string(),
        level: z.enum(["campaign", "adset", "ad"]),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ rows: EntityRollupRow[]; error: string | null }> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { rows: [], error: null };
    try {
      const rows = await pgRpc<EntityRollupRow[]>(pg, "entity_rollup", {
        p_start: data.since,
        p_end: data.until,
        p_level: data.level,
      });
      return { rows: rows ?? [], error: null };
    } catch (e) {
      return { rows: [], error: safeMessage(e) };
    }
  });

export const getBreakEvenInputs = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ inputs: BreakEvenInputs; error: string | null }> => {
    const { getPg, pgSelect } = await import("./pg.server");
    const pg = getPg();
    const fallback: BreakEvenInputs = {
      // Never an assumed price: the realised average from the ledger is used,
      // and where there is none the ceiling is simply not produced.
      l1Price: 0,
      backendPrice: 230000,
      ascensionRate: 21.5,
      buyersPer1000: 0,
      buyersPer1000Note: null,
    };
    if (!pg) return { inputs: fallback, error: null };
    try {
      const rows = await pgSelect<SettingRow[]>(
        pg,
        `/app_settings?select=key,value,description&key=in.(${SETTING_KEYS.join(",")})`,
      );
      return { inputs: toBreakEven(rows ?? []), error: null };
    } catch (e) {
      return { inputs: fallback, error: safeMessage(e) };
    }
  },
);

export const saveBreakEvenInputs = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        l1Price: z.number().positive(),
        backendPrice: z.number().positive(),
        ascensionRate: z.number().min(0).max(100),
        buyersPer1000: z.number().min(0),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error: string | null }> => {
    const { getPg, pgUpdate } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { ok: false, error: "Backend is not configured." };
    try {
      const pairs: [string, number][] = [
        ["breakeven_l1_price", data.l1Price],
        ["breakeven_backend_price", data.backendPrice],
        ["breakeven_ascension_rate", data.ascensionRate],
        ["breakeven_buyers_per_1000", data.buyersPer1000],
      ];
      for (const [key, value] of pairs) {
        await pgUpdate(pg, "app_settings", `key=eq.${key}`, {
          value: String(value),
          updated_at: new Date().toISOString(),
        });
      }
      return { ok: true, error: null };
    } catch (e) {
      return { ok: false, error: safeMessage(e) };
    }
  });

/** Measured buyers-per-1,000 straight from the database, for the Settings hint. */
export const getMeasuredConversion = createServerFn({ method: "GET" }).handler(
  async (): Promise<{
    buyers: number | null;
    registrations: number | null;
    perThousand: number | null;
    /** Average cash actually received per Silver sale, ex-GST. Never assumed. */
    avgRealised: number | null;
    error: string | null;
  }> => {
    const { getPg, pgSelect, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg)
      return { buyers: null, registrations: null, perThousand: null, avgRealised: null, error: null };
    try {
      const year = new Date().getUTCFullYear();
      // Buyers come from the accounts ledger — the only authoritative sale count.
      const sales = await pgSelect<{ business_date: string }[]>(
        pg,
        `/ledger_inflow?select=business_date&is_new_sale=is.true&product_tier=eq.L1_SILVER&business_date=gte.${year}-01-01&limit=100000`,
      );

      const metrics = await pgSelect<{ leads: number | null }[]>(
        pg,
        `/daily_metrics?select=leads&level=eq.account&leads=not.is.null&date=gte.${year}-01-01&limit=100000`,
      );
      const buyers = sales?.length ?? 0;
      const registrations = (metrics ?? []).reduce((a, r) => a + (r.leads ?? 0), 0);
      const asc = await pgRpc<{ l1_avg_ticket: number | null }[]>(pg, "measured_ascension", {}).catch(
        () => null,
      );
      const avg = Number(asc?.[0]?.l1_avg_ticket);
      return {
        buyers,
        registrations,
        perThousand: registrations > 0 ? (buyers / registrations) * 1000 : null,
        avgRealised: Number.isFinite(avg) ? avg : null,
        error: null,
      };
    } catch (e) {
      return {
        buyers: null,
        registrations: null,
        perThousand: null,
        avgRealised: null,
        error: safeMessage(e),
      };
    }
  },
);

export const triggerSync = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        since: z.string().nullable().optional(),
        until: z.string().nullable().optional(),
        level: z.enum(["account", "campaign", "adset", "ad"]).optional(),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data }): Promise<SyncSummary> => {
    const { runMetaSync } = await import("./meta-sync.server");
    const result = await runMetaSync({
      since: data.since ?? null,
      until: data.until ?? null,
      source: "manual",
      levels: [data.level ?? "account"],
    });
    return {
      status: result.status,
      rowsWritten: result.rowsWritten,
      accountsSynced: result.accountsSynced,
      since: result.since,
      until: result.until,
      error: result.error,
    };
  });
