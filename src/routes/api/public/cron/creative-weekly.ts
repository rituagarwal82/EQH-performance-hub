import { createFileRoute } from "@tanstack/react-router";

/**
 * The weekly concept pass — Mondays. Tests every ledger rule and files the
 * transitions it can justify as review items. It never changes a state and
 * never touches spend.
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { asof?: string | null } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }

  try {
    const { proposeTransitions } = await import("@/lib/concepts.server");
    const result = await proposeTransitions(body.asof ?? null);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/creative-weekly")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
