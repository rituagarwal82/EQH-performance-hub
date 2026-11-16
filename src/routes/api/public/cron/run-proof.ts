import { createFileRoute } from "@tanstack/react-router";

async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { since?: string | null; until?: string | null } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }

  try {
    const { runGuardedJob, guardedResponse } = await import("@/lib/cron-job.server");
    const { runProofChecks } = await import("@/lib/proof.server");
    const outcome = await runGuardedJob("proof", () =>
      runProofChecks({
        since: body.since ?? null,
        until: body.until ?? null,
        source: "proof",
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


export const Route = createFileRoute("/api/public/cron/run-proof")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
