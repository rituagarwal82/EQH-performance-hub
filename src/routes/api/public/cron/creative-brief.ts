import { createFileRoute } from "@tanstack/react-router";

/**
 * The fortnightly creative brief — 1st and 15th. The scheduler fires daily
 * and the handler exits on every other date, so a missed day is skipped
 * rather than written against the wrong fortnight.
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { for_date?: string | null; force?: boolean } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }

  const forDate = body.for_date ?? new Date().toISOString().slice(0, 10);
  const day = Number(forDate.slice(8, 10));
  if (body.force !== true && day !== 1 && day !== 15) {
    return Response.json(
      {
        status: "skipped",
        for_date: forDate,
        reason: "briefs are written on the 1st and the 15th",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const { runCreativeBrief } = await import("@/lib/creative-brief.server");
    const result = await runCreativeBrief({ forDate });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/creative-brief")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
