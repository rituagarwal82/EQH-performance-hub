import { createFileRoute } from "@tanstack/react-router";

/**
 * Creative Intelligence ingestion, on a schedule:
 *   - creative text (body / title / thumbnail) per ad
 *   - age + gender breakdowns at ad level (two Meta passes)
 *   - the script auto-matcher
 *
 *   POST /api/public/cron/sync-creative
 *   header: x-cron-secret: <LOVABLE_CRON_SECRET>
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { runGuardedJob, guardedResponse } = await import("@/lib/cron-job.server");
  const outcome = await runGuardedJob("creative-sync", async () => {
    const { syncCreativeText, syncDemoBreakdowns } = await import("@/lib/creative-sync.server");
    const { runScriptMatch } = await import("@/lib/script-match.server");

    const text = await syncCreativeText();
    const demo = await syncDemoBreakdowns();
    const match = await runScriptMatch();

    const status =
      text.status === "error" && demo.status === "error"
        ? "error"
        : text.status === "success" && demo.status === "success" && !match.error
          ? "success"
          : "partial";

    return { status, text, demo, match };
  });

  return guardedResponse(outcome);
}


export const Route = createFileRoute("/api/public/cron/sync-creative")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
    },
  },
});
