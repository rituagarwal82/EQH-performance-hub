import { createFileRoute } from "@tanstack/react-router";

/**
 * WEEKLY: TEST THE ALARMS THEMSELVES.
 *
 * A silent alarm is worse than no alarm. Once a week this asserts that every
 * scheduled job has an interval and a plain name, that each feed's freshness
 * rule actually evaluates, that the signed-off figure checks ran, and that
 * every credential says what breaks if it lapses. Anything that could not be
 * evaluated raises one plain item on the owner's screen.
 */
export const Route = createFileRoute("/api/public/cron/self-test")({
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
          const out = await pgRpc<{ ok?: boolean }>(pg, "safety_net_selftest", {});
          return Response.json(
            { status: out?.ok ? "success" : "warning", selftest: out },
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
