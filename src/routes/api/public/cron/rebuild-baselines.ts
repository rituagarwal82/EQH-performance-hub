import { createFileRoute } from "@tanstack/react-router";

/**
 * Nightly recompute of the 28-day normal-range baselines the verdict engine
 * reads. Called by pg_cron; the shared cron secret gates it.
 */
export const Route = createFileRoute("/api/public/cron/rebuild-baselines")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { isCronAuthorized } = await import("@/lib/cron-auth.server");
        if (!isCronAuthorized(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { getPg, pgRpc } = await import("@/lib/pg.server");
        const pg = getPg();
        if (!pg) {
          return Response.json(
            { status: "error", error: "backend not configured" },
            { status: 500 },
          );
        }
        // One grain per statement, paced. All three in a single call exceeded
        // the database's time limit, which is why this job had never once
        // completed — and a job that never completes is not a green tick.
        const grains = ["day", "week"] as const;
        const done: Record<string, number> = {};
        const failed: { grain: string; error: string }[] = [];
        for (const grain of grains) {
          try {
            const rows = await pgRpc<number>(pg, "rebuild_metric_baselines_grain", {
              p_grain: grain,
              p_asof: null,
            });
            done[grain] = Number(rows ?? 0);
          } catch (error) {
            failed.push({
              grain,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          await new Promise((r) => setTimeout(r, 250));
        }

        // The month grain needs a year of history, and a year in one statement
        // never finished. Twelve one-month reads, paced, then the medians are
        // taken here and written in a single small statement.
        try {
          const now = new Date();
          const byMetric = new Map<string, number[]>();
          for (let back = 12; back >= 1; back -= 1) {
            const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
            const rows = await pgRpc<{ metric_id: string; value: number | string }[]>(
              pg,
              "metric_month_values",
              { p_month_start: d.toISOString().slice(0, 10) },
            );
            for (const r of rows ?? []) {
              const v = Number(r.value);
              if (!Number.isFinite(v)) continue;
              const list = byMetric.get(r.metric_id) ?? [];
              list.push(v);
              byMetric.set(r.metric_id, list);
            }
            await new Promise((r) => setTimeout(r, 150));
          }
          const median = (xs: number[]) => {
            const s = [...xs].sort((a, b) => a - b);
            const m = Math.floor(s.length / 2);
            return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
          };
          const payload = [...byMetric.entries()].map(([metric_id, xs]) => {
            const med = median(xs);
            return {
              metric_id,
              grain: "month",
              weekday_class: "all",
              median: med,
              mad: median(xs.map((x) => Math.abs(x - med))),
              n: xs.length,
            };
          });
          if (payload.length > 0) {
            const written = await pgRpc<number>(pg, "write_metric_baselines", { p_rows: payload });
            done["month"] = Number(written ?? 0);
          } else {
            done["month"] = 0;
          }
        } catch (error) {
          failed.push({
            grain: "month",
            error: error instanceof Error ? error.message : String(error),
          });
        }

        const attempted = grains.length + 1;
        return Response.json(
          {
            status:
              failed.length === 0 ? "success" : failed.length < attempted ? "partial" : "error",
            rows: done,
            failed,
          },
          { status: failed.length === attempted ? 500 : 200 },
        );
      },
    },
  },
});
