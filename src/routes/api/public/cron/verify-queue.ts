import { createFileRoute } from "@tanstack/react-router";

/**
 * Re-checks every open review item's underlying condition and closes only the
 * ones that verifiably pass now. Judgement items are always kept.
 */
export const Route = createFileRoute("/api/public/cron/verify-queue")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { isCronAuthorized } = await import("@/lib/cron-auth.server");
        if (!isCronAuthorized(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const { getPg } = await import("@/lib/pg.server");
        const pg = getPg();
        if (!pg) {
          return Response.json(
            { status: "error", error: "backend not configured" },
            { status: 500 },
          );
        }
        try {
          const { runGuardedJob, guardedResponse } = await import("@/lib/cron-job.server");
          const { verifyOpenReviewItems } = await import("@/lib/queue-verify.server");
          const outcome = await runGuardedJob("queue-verify", async () => ({
            status: "success" as const,
            ...(await verifyOpenReviewItems(pg)),
          }));
          return guardedResponse(outcome);
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
