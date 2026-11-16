import { createFileRoute } from "@tanstack/react-router";

/**
 * Runs after the syncs, the baselines and the verdict — 06:30 UTC. One brief
 * per day; a failure is recorded as a failed run and surfaces on /health.
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { for_date?: string | null } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }

  try {
    const { runAnalystBrief } = await import("@/lib/analyst.server");
    const result = await runAnalystBrief({ forDate: body.for_date ?? null });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/run-analyst")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
