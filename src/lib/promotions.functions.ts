/**
 * Promotions as a first-class fact, and the realised value of a sale.
 *
 * Owner ruling, 22 Sep 2026: never assume a sale price. Offers recur and
 * overseas buyers pay a different amount, so every money figure rests on the
 * cash actually received, converted to rupees at the rate stored on the
 * payment. The standing list price is held as a recorded setting and used only
 * to judge full price against discounted.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type Promotion = {
  code: string;
  name: string;
  discounted_price: number;
  list_price: number;
  starts_on: string | null;
  ends_on: string | null;
  dates_confirmed: boolean;
  note: string | null;
  is_active: boolean;
};

export type PromotionTotal = {
  code: string;
  name: string;
  first_used: string | null;
  last_used: string | null;
  sales: number;
  cash_received: number;
  discount_given: number;
  avg_sale_value: number | null;
};

export type WeeklyValue = {
  week_start: string;
  sales: number;
  promotion_sales: number;
  avg_sale_value: number | null;
  discount_given: number;
};

export type DayMix = {
  business_date: string;
  sales: number;
  full_price_sales: number;
  discounted_sales: number;
  promotion_sales: number;
  overseas_sales: number;
  cash_received: number;
  avg_sale_value: number | null;
  discount_given: number;
};

export type SourceMix = {
  source: string;
  sales: number;
  full_price_sales: number;
  discounted_sales: number;
  overseas_sales: number;
  cash_received: number;
  avg_sale_value: number | null;
  discount_given: number;
};

export type WindowPromotion = {
  code: string;
  name: string;
  discounted_price: number;
  list_price: number;
  starts_on: string | null;
  ends_on: string | null;
  dates_confirmed: boolean;
  sales_in_window: number;
  discount_in_window: number;
};

/** What the owner actually earns, week by week. Nothing here is assumed. */
export type RealisedWeek = {
  week_start: string;
  sales: number;
  cash_received: number;
  avg_realised: number | null;
  full_price_sales: number;
  discounted_sales: number;
  discount_given: number;
  overseas_sales: number;
  overseas_cash: number;
  overseas_avg: number | null;
  domestic_avg: number | null;
  offers: string | null;
};

export type PromotionsPayload = {
  configured: boolean;
  promotions: Promotion[];
  totals: PromotionTotal[];
  weekly: WeeklyValue[];
};

export type PriceMixPayload = {
  configured: boolean;
  since: string;
  until: string;
  daily: DayMix[];
  bySource: SourceMix[];
  inWindow: WindowPromotion[];
  realisedWeeks: RealisedWeek[];
  listPrice: number | null;
};

const rangeInput = z.object({ since: z.string(), until: z.string() });

export const getPromotions = createServerFn({ method: "GET" }).handler(
  async (): Promise<PromotionsPayload> => {
    const { getPg, pgRpc, pgSelect } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { configured: false, promotions: [], totals: [], weekly: [] };
    const [promotions, totals, weekly] = await Promise.all([
      pgSelect<Promotion[]>(pg, "/promotions?select=*&order=starts_on.desc.nullslast"),
      pgRpc<PromotionTotal[]>(pg, "promotion_totals", {}),
      pgRpc<WeeklyValue[]>(pg, "price_mix_weekly", { p_code: null }),
    ]);
    return {
      configured: true,
      promotions: promotions ?? [],
      totals: totals ?? [],
      weekly: weekly ?? [],
    };
  },
);

export const getPriceMix = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => rangeInput.parse(data))
  .handler(async ({ data }): Promise<PriceMixPayload> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    const empty: PriceMixPayload = {
      configured: false,
      since: data.since,
      until: data.until,
      daily: [],
      bySource: [],
      inWindow: [],
      realisedWeeks: [],
      listPrice: null,
    };
    if (!pg) return empty;
    const { pgSelect } = await import("./pg.server");
    const args = { p_start: data.since, p_end: data.until };
    const [daily, bySource, inWindow, weeks, setting] = await Promise.all([
      pgRpc<DayMix[]>(pg, "price_mix_daily", args),
      pgRpc<SourceMix[]>(pg, "price_mix_by_source", args),
      pgRpc<WindowPromotion[]>(pg, "promotions_in_window", args),
      pgRpc<RealisedWeek[]>(pg, "realised_sale_value_weekly", { p_weeks: 8 }),
      pgSelect<{ value: string | null }[]>(pg, "/app_settings?select=value&key=eq.l1_list_price"),
    ]);
    const listed = Number(setting?.[0]?.value);
    return {
      configured: true,
      since: data.since,
      until: data.until,
      daily: daily ?? [],
      bySource: bySource ?? [],
      inWindow: inWindow ?? [],
      realisedWeeks: weeks ?? [],
      listPrice: Number.isFinite(listed) ? listed : null,
    };
  });

export const savePromotion = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        code: z.string().min(2),
        name: z.string().min(2),
        discounted_price: z.number(),
        list_price: z.number(),
        starts_on: z.string().nullable(),
        ends_on: z.string().nullable(),
        dates_confirmed: z.boolean(),
        note: z.string().nullable(),
        is_active: z.boolean(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { getPg, pgUpsert } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { ok: false };
    await pgUpsert(pg, "promotions", data);
    return { ok: true };
  });

export const deletePromotion = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ code: z.string().min(2) }).parse(data))
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    const { getPg, pgDelete } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { ok: false };
    await pgDelete(pg, "promotions", `code=eq.${encodeURIComponent(data.code)}`);
    return { ok: true };
  });
