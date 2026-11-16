import { createFileRoute } from "@tanstack/react-router";

async function handle(request: Request) {
  // Accept the same credentials as the other cron endpoints: the scheduler in
  // the database sends an apikey header, not x-cron-secret.
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { restart?: boolean; batchSize?: number; passes?: number } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    const { runGuardedJob, guardedResponse } = await import("@/lib/cron-job.server");
    const { runTagMangoPaymentSync } = await import("@/lib/tagmango-payments.server");
    const passes = Math.max(1, Math.min(body.passes ?? 3, 20));
    const outcome = await runGuardedJob("tagmango-payments", async () => {
      let last = await runTagMangoPaymentSync({
        ...(body.restart === undefined ? {} : { restart: body.restart }),
        ...(body.batchSize === undefined ? {} : { batchSize: body.batchSize }),
      });
      for (let pass = 1; pass < passes && last.hasMore; pass += 1) {
        last = await runTagMangoPaymentSync(
          body.batchSize === undefined ? {} : { batchSize: body.batchSize },
        );
      }
      return last;
    });
    return guardedResponse(outcome);
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}


export const Route = createFileRoute("/api/public/sync-tagmango-payments")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
