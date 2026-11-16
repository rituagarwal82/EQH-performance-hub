import { createFileRoute } from "@tanstack/react-router";

async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { limit?: number } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }

  try {
    const { runZoomHostBackfill } = await import("@/lib/zoom-sync.server");
    const result = await runZoomHostBackfill(body.limit ?? 500);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/zoom-host-backfill")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
