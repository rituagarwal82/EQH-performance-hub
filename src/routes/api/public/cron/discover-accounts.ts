import { createFileRoute } from "@tanstack/react-router";
import { safeMessage } from "@/lib/safe-error";

/**
 * Standalone daily account discovery. The same reconciliation also runs inside
 * every full Meta sync; this route exists so it can be scheduled on its own
 * cadence and probed on demand.
 *
 * Optional body: { probe: "<act id>" } — reports Meta's EXACT response for one
 * account, so a permission problem is reported verbatim, never guessed.
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { probe?: string } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }

  const token = process.env["META_ACCESS_TOKEN"];
  if (!token) {
    return Response.json(
      { status: "error", error: "META_ACCESS_TOKEN is not set." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const { runAccountDiscovery } = await import("@/lib/meta-discovery.server");

    let probe: unknown = null;
    if (body.probe) {
      const { graphGet } = await import("@/lib/meta-sync.server");
      const id = body.probe.startsWith("act_") ? body.probe : `act_${body.probe}`;
      try {
        const meta = await graphGet<Record<string, unknown>>(
          `/${id}`,
          { fields: "account_id,name,account_status,currency,created_time,business" },
          token,
        );
        const insights = await graphGet<{ data: unknown[] }>(
          `/${id}/insights`,
          {
            fields: "spend,impressions,inline_link_clicks",
            date_preset: "maximum",
            level: "account",
          },
          token,
        );
        probe = { reachable: true, account: meta, insights: insights.data ?? [] };
      } catch (e) {
        probe = { reachable: false, error: safeMessage(e) };
      }
    }

    const result = await runAccountDiscovery(token);
    return Response.json({ ...result, probe }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/discover-accounts")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
