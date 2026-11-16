import { createFileRoute } from "@tanstack/react-router";

/**
 * Scheduled lead ingestion. Default run re-pulls the trailing 3 days, because
 * contacts get tags and fields after creation. Backfill is explicit: post
 * `{ "days": 90 }` (or a `since` date).
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { since?: string; until?: string; days?: number; maxPages?: number } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    const { runGuardedJob, guardedResponse } = await import("@/lib/cron-job.server");
    const { runGhlLeadSync } = await import("@/lib/ghl-sync.server");
    const outcome = await runGuardedJob("ghl-leads", () =>
      runGhlLeadSync({
        since: body.since ?? null,
        until: body.until ?? null,
        days: body.days ?? 3,
        ...(body.maxPages === undefined ? {} : { maxPages: body.maxPages }),
        source: "ghl-leads",
      }),
    );
    return guardedResponse(outcome);
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}


export const Route = createFileRoute("/api/public/cron/sync-ghl-leads")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
