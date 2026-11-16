import { createFileRoute } from "@tanstack/react-router";

/**
 * Nightly (and on-demand) refresh of the stored source attribution the Sources
 * screen reads. Run it by hand after any dictionary change or source rebuild.
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { runGuardedJob, guardedResponse } = await import("@/lib/cron-job.server");
    const { refreshSourcePrecompute } = await import("@/lib/source-precompute.server");
    const outcome = await runGuardedJob("source-precompute", () => refreshSourcePrecompute());
    return guardedResponse(outcome);
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/refresh-source-precompute")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
