import { createFileRoute } from "@tanstack/react-router";

async function handle(request: Request) {
  // Same credentials as the other cron endpoints: the database scheduler sends
  // an apikey header, not x-cron-secret.
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { runTagMangoProductSync } = await import("@/lib/tagmango-sync.server");
    const result = await runTagMangoProductSync();
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/sync-tagmango-products")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
