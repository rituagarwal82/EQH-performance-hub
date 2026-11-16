import { createFileRoute } from "@tanstack/react-router";

async function handle(request: Request) {
  // Accept the same credentials as the other cron endpoints: the scheduler in
  // the database sends an apikey header, not x-cron-secret.
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // The scheduled route can ONLY do the ordinary incremental refresh. A full
  // re-import replaces the whole collections ledger, so it is deliberately not
  // reachable from here — it lives behind the typed confirmation in the app.
  let body: { chunks?: number } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    const { runGuardedJob, guardedResponse } = await import("@/lib/cron-job.server");
    const { runLedgerSync } = await import("@/lib/ledger-sheet.server");
    const outcome = await runGuardedJob("ledger-sheet", () =>
      runLedgerSync({
        ...(body.chunks === undefined ? {} : { chunks: body.chunks }),
        // Scheduled runs always re-read the trailing 60 days: accounts backdate rows.
        refresh: true,
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


export const Route = createFileRoute("/api/public/sync-ledger")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
