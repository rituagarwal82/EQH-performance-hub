import { createFileRoute } from "@tanstack/react-router";

/**
 * Nightly re-derivation of every verified historical figure, plus the metric
 * definition drift check. Run separately from the proof pass so a slow golden
 * can never delay the morning brief that follows the proof run.
 */
export const Route = createFileRoute("/api/public/cron/run-goldens")({
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

        try {
          const drift = await pgRpc<Record<string, unknown>>(pg, "contract_drift", {});
          const goldens = await pgRpc<{ pass: number; fail: number }>(pg, "run_golden_tests", {
            p_trigger: "nightly",
          });
          return Response.json(
            {
              status: goldens && goldens.fail > 0 ? "warning" : "success",
              goldens,
              contracts: drift,
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 500, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
