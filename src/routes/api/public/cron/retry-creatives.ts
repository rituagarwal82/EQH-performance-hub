import { createFileRoute } from "@tanstack/react-router";

/**
 * ON DEMAND: ask Meta again, one ad at a time, for the creatives that the
 * whole-account call could not deliver. Run it after a rate-limited creative
 * sync; the daily sync stays as it is.
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { days?: number } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }

  try {
    const { retryFailedCreatives } = await import("@/lib/creative-sync.server");
    const result = await retryFailedCreatives({ days: body.days ?? 30 });
    return Response.json(
      { status: result.recovered > 0 ? "success" : "success_no_yield", ...result },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/retry-creatives")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
