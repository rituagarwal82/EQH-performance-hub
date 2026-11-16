import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeMessage } from "./safe-error";

/**
 * Everything /ads needs that the account rollup cannot answer: how many rows
 * each grain actually holds (so a grain button can state its coverage BEFORE
 * the click), and the placement breakout.
 *
 * A near-empty grain and "these ad sets did not spend" are different facts.
 */

export type GrainCount = {
  level: "campaign" | "adset" | "ad";
  rows_n: number | string;
  entities: number | string;
  spend: number | string;
};

export type PlacementRow = {
  placement: string;
  rows_n: number | string;
  spend: number | string;
  impressions: number | string;
  link_clicks: number | string;
  leads: number | string | null;
  days_covered: number | string;
};

export type AdsMeta = {
  grains: GrainCount[];
  placements: PlacementRow[];
  /** Rows in the window that carry no placement value at all. */
  placementRowsMissing: number;
  placementRowsTotal: number;
  error: string | null;
};

export const getAdsMeta = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ since: z.string(), until: z.string() }).parse(data))
  .handler(async ({ data }): Promise<AdsMeta> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    const empty: AdsMeta = {
      grains: [],
      placements: [],
      placementRowsMissing: 0,
      placementRowsTotal: 0,
      error: null,
    };
    if (!pg) return empty;
    try {
      const [grains, placements] = await Promise.all([
        pgRpc<GrainCount[]>(pg, "entity_grain_counts", {
          p_start: data.since,
          p_end: data.until,
        }),
        pgRpc<PlacementRow[]>(pg, "placement_rollup", {
          p_start: data.since,
          p_end: data.until,
        }),
      ]);
      const rows = placements ?? [];
      const total = rows.reduce((a, r) => a + (Number(r.rows_n) || 0), 0);
      const missing = rows
        .filter((r) => r.placement === "(not reported)")
        .reduce((a, r) => a + (Number(r.rows_n) || 0), 0);
      return {
        grains: grains ?? [],
        placements: rows.filter((r) => r.placement !== "(not reported)"),
        placementRowsMissing: missing,
        placementRowsTotal: total,
        error: null,
      };
    } catch (e) {
      return { ...empty, error: safeMessage(e) };
    }
  });

/** A single entity's 30-day daily trend plus its children one grain down. */
export type EntityDrill = {
  trend: { date: string; spend: number | string; leads: number | string | null }[];
  children: import("./dashboard-types").EntityRollupRow[];
  childLevel: "adset" | "ad" | null;
  error: string | null;
};

export const getEntityDrill = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    z
      .object({
        entityId: z.string().min(1),
        level: z.enum(["campaign", "adset", "ad"]),
        since: z.string(),
        until: z.string(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<EntityDrill> => {
    const { getPg, pgRpc, pgSelect } = await import("./pg.server");
    const pg = getPg();
    const empty: EntityDrill = { trend: [], children: [], childLevel: null, error: null };
    if (!pg) return empty;
    const childLevel = data.level === "campaign" ? "adset" : data.level === "adset" ? "ad" : null;
    try {
      const trend = await pgSelect<EntityDrill["trend"]>(
        pg,
        `/daily_metrics?select=date,spend,leads&entity_id=eq.${encodeURIComponent(
          data.entityId,
        )}&order=date.asc&limit=400`,
      );
      let children: import("./dashboard-types").EntityRollupRow[] = [];
      if (childLevel) {
        const kids = await pgSelect<{ entity_id: string }[]>(
          pg,
          `/ad_entities?select=entity_id&parent_id=eq.${encodeURIComponent(
            data.entityId,
          )}&level=eq.${childLevel}&limit=500`,
        );
        const ids = new Set((kids ?? []).map((k) => k.entity_id));
        if (ids.size > 0) {
          const all = await pgRpc<import("./dashboard-types").EntityRollupRow[]>(
            pg,
            "entity_rollup",
            { p_start: data.since, p_end: data.until, p_level: childLevel },
          );
          children = (all ?? []).filter((r) => ids.has(r.entity_id));
        }
      }
      return { trend: trend ?? [], children, childLevel, error: null };
    } catch (e) {
      return { ...empty, error: safeMessage(e) };
    }
  });
