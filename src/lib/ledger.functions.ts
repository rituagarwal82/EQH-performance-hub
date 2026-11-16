import { createServerFn } from "@tanstack/react-start";

/**
 * Revenue, sales counts, cost per sale and ROAS — all of it from the accounts
 * team's ledger (`ledger_inflow`), never from TagMango.
 *
 * Break-even and ROAS here are GROSS: no platform fees, agency commission,
 * delivery cost or refunds at this reporting level. That is a deliberate ruling
 * by the owner, and every screen labels it as gross.
 */

export type LedgerDailyRow = {
  business_date: string;
  sales: number | string;
  collected: number | string;
  pending: number | string;
  rows_count: number | string;
};

export type LedgerMonthlyRow = {
  period: string;
  sales: number | string;
  collected: number | string;
  buyers: number | string;
};

export type LedgerRailRow = {
  receipt_source: string;
  rows_count: number | string;
  collected: number | string;
  share_pct: number | string | null;
};

export type CostPerSale = {
  spend: number;
  sales: number;
  costPerSale: number | null;
  /**
   * Paid front-end ROAS, ex-GST: only first-time L1 sales whose buyer is a lead
   * with a paid marker, divided by 1.18, over Meta spend. Blended cash is
   * carried separately and is never this number.
   */
  roas: number | null;
};

export type PaidSplit = {
  all: number;
  noLead: number;
  instalment: number;
  paidGross: number;
  paidExGst: number;
  /**
   * I-SYM: cash from leads whose team's ad spend does not reach us (e.g. the
   * in-house RJ account before it is connected). Held out of every paid ratio
   * so revenue never lands in a numerator whose cost side is invisible.
   */
  unsyncedGross: number;
  unsyncedRows: number;
};


export type AgencyLine = {
  agency: string;
  spend: number;
  active: boolean;
};

/**
 * Book My Seat deposits. Owner ruling 2026-09-06: a seat deposit is not a sale.
 * The sale is recognised only when the balance completes, and is dated on the
 * completing payment. Deposits are still real rupees, so they stay inside every
 * cash figure — they are only held out of the sale count and conversion ratios.
 */
export type SeatStats = {
  bookings: number;
  completed: number;
  completionRate: number | null;
  medianDays: number | null;
  depositsReceived: number;
  balanceOutstanding: number;
  held: number;
  /** Seats still open today, counted over all history — never window-clipped. */
  openHeld: number;
  openDeposits: number;
  openBalance: number;

};


export type RevenueData = {
  connected: boolean;
  configured: boolean;
  since: string;
  until: string;
  lastSync: string | null;
  totalRows: number;
  daily: LedgerDailyRow[];
  monthly: LedgerMonthlyRow[];
  /** Meta spend by calendar month, so the monthly table can sit money against cost. */
  monthlySpend: { period: string; spend: number }[];
  byRail: LedgerRailRow[];

  totals: {
    sales: number;
    collected: number;
    pending: number;
    rows: number;
    buyers: number;
  };
  agencies: AgencyLine[];
  paid: PaidSplit | null;
  goForward: CostPerSale;
  all: CostPerSale;
  terminated: CostPerSale;
  seats: SeatStats | null;
  /** The registry's cost_per_sale: measured spend ÷ paid-attributed ledger sales. */
  canonicalCostPerSale: { spend: number; sales: number; value: number | null } | null;

  error: string | null;
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function costPerSale(spend: number, sales: number, paidExGst: number): CostPerSale {
  return {
    spend,
    sales,
    costPerSale: sales > 0 ? spend / sales : null,
    // No ledger rows imported means revenue is unmeasured, not zero — never render 0.00.
    roas: spend > 0 && paidExGst > 0 ? paidExGst / spend : null,
  };
}

export const getRevenue = createServerFn({ method: "GET" })
  .inputValidator((data: { since?: string; until?: string; tier?: string }) => data ?? {})
  .handler(async ({ data }): Promise<RevenueData> => {
    const { getPg, pgRpc, pgSelect } = await import("./pg.server");
    const since = data.since ?? "2026-01-01";
    const until = data.until ?? new Date().toISOString().slice(0, 10);
    const tier = data.tier ?? "L1_SILVER";

    const empty: RevenueData = {
      connected: Boolean(process.env["GOOGLE_SHEETS_API_KEY"]),
      configured: false,
      since,
      until,
      lastSync: null,
      totalRows: 0,
      daily: [],
      monthly: [],
      monthlySpend: [],
      byRail: [],

      totals: { sales: 0, collected: 0, pending: 0, rows: 0, buyers: 0 },
      agencies: [],
      paid: null,
      goForward: costPerSale(0, 0, 0),
      all: costPerSale(0, 0, 0),
      terminated: costPerSale(0, 0, 0),
      seats: null,
      canonicalCostPerSale: null,

      error: null,
    };

    const pg = getPg();
    if (!pg) return empty;

    try {
      const [
        daily,
        monthly,
        rangeTotals,
        byRail,
        settings,
        accounts,
        paidDaily,
        seatRows,
        heldRows,
      ] =
        await Promise.all([
        pgRpc<LedgerDailyRow[]>(pg, "ledger_daily", { p_start: since, p_end: until, p_tier: tier }),
        pgRpc<LedgerMonthlyRow[]>(pg, "ledger_monthly", {
          p_start: since,
          p_end: until,
          p_tier: tier,
        }),
        pgRpc<{ buyers: number | string }[]>(pg, "ledger_range_totals", {
          p_start: since,
          p_end: until,
          p_tier: tier,
        }),
        pgRpc<LedgerRailRow[]>(pg, "ledger_rail_rollup", {
          p_start: since,
          p_end: until,
          p_tier: tier,
        }),
        pgSelect<{ key: string; value: string | null }[]>(
          pg,
          "/app_settings?key=eq.ledger_last_sync&select=key,value",
        ),
        pgRpc<
          {
            account_id: string;
            agency_code: string | null;
            is_active: boolean;
            spend: number | string;
          }[]
        >(pg, "account_month_rollup", { p_start: since, p_end: until }),
        pgRpc<
          {
            collected_all: number | string;
            collected_no_lead: number | string;
            collected_instalment: number | string;
            collected_paid_gross: number | string;
            collected_paid_exgst: number | string;
            collected_unsynced_gross: number | string;
            rows_unsynced: number | string;
          }[]
        >(pg, "ledger_paid_daily", { p_start: since, p_end: until }),
        pgRpc<
          {
            bookings: number | string;
            completed: number | string;
            completion_rate: number | string | null;
            median_days: number | string | null;
            deposits_received: number | string;
            balance_outstanding: number | string;
            held: number | string;
          }[]
        >(pg, "seat_completion_stats", { p_start: since, p_end: until }),
        pgRpc<
          {
            held: number | string;
            deposits_received: number | string;
            balance_outstanding: number | string;
          }[]
          // Seats booked before this window can still be open today, so the
          // held line is always carried at full history, not window-clipped.
        >(pg, "held_seats", { p_start: "2023-01-01", p_end: until }),
      ]);

      // Meta spend by calendar month, for the years this window touches. Spend
      // is a cost line beside collections — never divided into them here.
      const years: number[] = [];
      for (let y = Number(since.slice(0, 4)); y <= Number(until.slice(0, 4)); y += 1) years.push(y);
      const spendByYear = await Promise.all(
        years.map((y) =>
          pgRpc<{ month: number; spend: number | string }[]>(pg, "monthly_spend", { p_year: y }),
        ),
      );
      // ONE cost per sale exists: total Meta spend divided by paid-attributed
      // ledger sales, exactly as contract v3 records it — the same spend
      // denominator ROAS uses, so the two can never disagree on one screen.
      // A failure here must NOT read as "no sales": it throws and the section
      // renders as failed.
      const componentRows = await pgRpc<
        { spend: number | string | null; paid_sales: number | string | null }[]
      >(pg, "metric_components", { p_start: since, p_end: until });
      const canonicalSpend = (componentRows ?? []).reduce((s, r) => s + num(r.spend), 0);
      const canonicalSales = (componentRows ?? []).reduce((s, r) => s + num(r.paid_sales), 0);
      const canonicalCostPerSale =
        canonicalSales > 0
          ? { spend: canonicalSpend, sales: canonicalSales, value: canonicalSpend / canonicalSales }
          : { spend: canonicalSpend, sales: canonicalSales, value: null };


      const monthlySpend = years.flatMap((y, i) =>
        (spendByYear[i] ?? []).map((r) => ({
          period: `${y}-${String(r.month).padStart(2, "0")}`,
          spend: num(r.spend),
        })),
      );



      // Only L1 spend is front-end spend, so the paid split only means anything
      // on the L1 tier; other tiers get no ROAS at all (see the screen).
      const paid: PaidSplit = (paidDaily ?? []).reduce(
        (acc, r) => ({
          all: acc.all + num(r.collected_all),
          noLead: acc.noLead + num(r.collected_no_lead),
          instalment: acc.instalment + num(r.collected_instalment),
          paidGross: acc.paidGross + num(r.collected_paid_gross),
          paidExGst: acc.paidExGst + num(r.collected_paid_exgst),
          unsyncedGross: acc.unsyncedGross + num(r.collected_unsynced_gross),
          unsyncedRows: acc.unsyncedRows + num(r.rows_unsynced),
        }),
        { all: 0, noLead: 0, instalment: 0, paidGross: 0, paidExGst: 0, unsyncedGross: 0, unsyncedRows: 0 },
      );


      const totals = daily.reduce(
        (acc, r) => ({
          sales: acc.sales + num(r.sales),
          collected: acc.collected + num(r.collected),
          pending: acc.pending + num(r.pending),
          rows: acc.rows + num(r.rows_count),
          buyers: 0,
        }),
        { sales: 0, collected: 0, pending: 0, rows: 0, buyers: 0 },
      );
      // Distinct buyers must be counted once over the whole range: a buyer who
      // paid in two months is one buyer, and summing the monthly distincts
      // double-counts exactly the repeat payers we care about.
      totals.buyers = num(rangeTotals?.[0]?.buyers);

      const agencyMap = new Map<string, AgencyLine>();
      for (const a of accounts) {
        const agency = a.agency_code ?? "—";
        const line = agencyMap.get(agency) ?? { agency, spend: 0, active: false };
        line.spend += num(a.spend);
        line.active = line.active || a.is_active;
        agencyMap.set(agency, line);
      }
      const agencies = [...agencyMap.values()].sort((x, y) => y.spend - x.spend);

      const allSpend = agencies.reduce((s, a) => s + a.spend, 0);
      const terminatedSpend = agencies.filter((a) => !a.active).reduce((s, a) => s + a.spend, 0);
      const goForwardSpend = allSpend - terminatedSpend;

      // Sales cannot be split by agency: no agency code exists in the historical
      // lead data, and the ledger's own Source of Student is unreliable. So both
      // cost-per-sale figures use the SAME denominator - every L1 sale in range -
      // and differ only in which spend is counted. A terminated agency's own
      // cost per sale stays unmeasurable until ad-level agency codes go live.
      return {
        connected: Boolean(process.env["GOOGLE_SHEETS_API_KEY"]),
        configured: true,
        since,
        until,
        lastSync: settings[0]?.value ?? null,
        totalRows: totals.rows,
        daily,
        monthly,
        monthlySpend,
        byRail,

        totals,
        seats: seatRows?.[0]
          ? {
              bookings: num(seatRows[0].bookings),
              completed: num(seatRows[0].completed),
              completionRate:
                seatRows[0].completion_rate === null ? null : num(seatRows[0].completion_rate),
              medianDays: seatRows[0].median_days === null ? null : num(seatRows[0].median_days),
              depositsReceived: num(seatRows[0].deposits_received),
              balanceOutstanding: num(seatRows[0].balance_outstanding),
              held: num(seatRows[0].held),
              openHeld: num(heldRows?.[0]?.held),
              openDeposits: num(heldRows?.[0]?.deposits_received),
              openBalance: num(heldRows?.[0]?.balance_outstanding),
            }
          : null,


        agencies,
        paid,
        canonicalCostPerSale,
        all: costPerSale(allSpend, totals.sales, paid.paidExGst),
        terminated: { spend: terminatedSpend, sales: 0, costPerSale: null, roas: null },
        goForward: costPerSale(goForwardSpend, totals.sales, paid.paidExGst),
        error: null,
      };
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : String(error) };
    }
  });

export type TierRow = {
  product_tier: string;
  rows_count: number | string;
  buyers: number | string;
  sales: number | string;
  collected: number | string;
  pending: number | string;
  avg_ticket: number | string | null;
};

/**
 * Every tier the ledger carries, not just L1. L3 Diamond is ~88% of collections
 * and was invisible in this product until now.
 */
export const getTierRollup = createServerFn({ method: "GET" })
  .inputValidator((data: { since: string; until: string }) => data)
  .handler(async ({ data }): Promise<TierRow[]> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return [];
    try {
      return await pgRpc<TierRow[]>(pg, "ledger_tier_rollup", {
        p_start: data.since,
        p_end: data.until,
      });
    } catch {
      return [];
    }
  });

export type ReconRow = {
  date: string;
  tm_sales: number | string | null;
  ledger_sales: number | string | null;
  collected: number | string | null;
  settling: boolean;
  divergence_pct: number | string | null;
  review: boolean;
};

/**
 * The two series side by side: TagMango enrolments (timely, complete, coupon
 * enrolments included) against the accounts ledger's New Sale Tagging and the
 * money actually typed in. A day is `settling` until three days have passed or
 * the two counts agree within 20%; only after that does a divergence become a
 * bookkeeping miss rather than ordinary lag.
 */
export const getSalesReconciliation = createServerFn({ method: "GET" })
  .inputValidator((data: { since: string; until: string }) => data)
  .handler(async ({ data }): Promise<ReconRow[]> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return [];
    try {
      return await pgRpc<ReconRow[]>(pg, "sales_reconciliation", {
        p_start: data.since,
        p_end: data.until,
      });
    } catch {
      return [];
    }
  });

export const syncLedger = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      restart?: boolean;
      chunks?: number;
      refresh?: boolean;
      confirm?: string;
      allowShrink?: boolean;
    }) => data ?? {},
  )
  .handler(async ({ data }) => {
    const { runLedgerSync } = await import("./ledger-sheet.server");
    try {
      return await runLedgerSync({
        ...(data.restart === undefined ? {} : { restart: data.restart }),
        ...(data.chunks === undefined ? {} : { chunks: data.chunks }),
        ...(data.refresh === undefined ? {} : { refresh: data.refresh }),
        ...(data.confirm === undefined ? {} : { confirm: data.confirm }),
        ...(data.allowShrink === undefined ? {} : { allowShrink: data.allowShrink }),
      });
    } catch (error) {
      return {
        status: "error" as const,
        rowsRead: 0,
        rowsWritten: 0,
        nextRow: null,
        hasMore: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });


export type DayReconRow = {
  side: "ledger_only" | "tagmango_only" | "both";
  email_key: string;
  person_name: string | null;
  first_at: string | null;
  tagmango_inr: number | string | null;
  list_price_inr: number | string | null;
  coupon_code: string | null;
  currency: string | null;
  ledger_inr: number | string | null;
  ledger_payment_type: string | null;
};

export type DayReconciliation = {
  date: string;
  rows: DayReconRow[];
  /** When each source was last read, so no "today" figure is read as final. */
  tagmangoLastRead: string | null;
  ledgerLastRead: string | null;
  ledgerLatestDay: string | null;
};

/**
 * The day's buyers, name by name, from BOTH sources — including the ones only
 * one source has. Money is stated in rupees; a foreign-currency order is
 * converted at the rate the payment carries, never added as-is.
 */
export const getDayReconciliation = createServerFn({ method: "GET" })
  .inputValidator((data: { date: string }) => data)
  .handler(async ({ data }): Promise<DayReconciliation> => {
    const { getPg, pgRpc, pgSelect } = await import("./pg.server");
    const pg = getPg();
    const empty: DayReconciliation = {
      date: data.date,
      rows: [],
      tagmangoLastRead: null,
      ledgerLastRead: null,
      ledgerLatestDay: null,
    };
    if (!pg) return empty;
    let rows: DayReconRow[] = [];
    try {
      rows = (await pgRpc<DayReconRow[]>(pg, "sales_day_reconciliation", { p_date: data.date })) ?? [];
    } catch {
      rows = [];
    }
    const [tm, led, latest] = await Promise.all([
      pgSelect<{ synced_at: string }[]>(pg, "/tm_payments?select=synced_at&order=synced_at.desc&limit=1").catch(
        () => [],
      ),
      pgSelect<{ finished_at: string | null }[]>(
        pg,
        "/sync_runs?select=finished_at&source=eq.ledger&order=finished_at.desc&limit=1",
      ).catch(() => []),
      pgSelect<{ business_date: string }[]>(
        pg,
        "/ledger_inflow?select=business_date&order=business_date.desc&limit=1",
      ).catch(() => []),
    ]);
    return {
      date: data.date,
      rows,
      tagmangoLastRead: tm[0]?.synced_at ?? null,
      ledgerLastRead: led[0]?.finished_at ?? null,
      ledgerLatestDay: latest[0]?.business_date ?? null,
    };
  });
