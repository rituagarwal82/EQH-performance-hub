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
    const { runZoomSync } = await import("@/lib/zoom-sync.server");
    const result = await runZoomSync({
      since: body.since ?? null,
      until: body.until ?? null,
      source: "zoom-cron",
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/sync-zoom")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
