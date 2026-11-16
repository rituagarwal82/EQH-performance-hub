import { createFileRoute } from "@tanstack/react-router";

/**
 * One batch of the full-history lead import. Bounded per call, resumable from
 * the stored cursor, and a no-op once the walk reaches the current month.
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    budgetMs?: number;
    maxMonths?: number;
    maxPagesPerMonth?: number;
    restartFrom?: string;
    force?: boolean;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  try {
    const { getPg, pgSelect } = await import("@/lib/pg.server");
    const pg = getPg();
    if (pg && !body.restartFrom) {
      const rows = await pgSelect<{ value: string | null }[]>(
        pg,
        "/app_settings?select=value&key=eq.ghl_backfill_status",
      );
      if (rows?.[0]?.value === "done") {
        return Response.json(
          { status: "skipped", note: "Full history already imported." },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
    }

    const { runGhlBackfill } = await import("@/lib/ghl-backfill.server");
    const result = await runGhlBackfill({
      ...(body.budgetMs === undefined ? {} : { budgetMs: body.budgetMs }),
      ...(body.maxMonths === undefined ? {} : { maxMonths: body.maxMonths }),
      ...(body.maxPagesPerMonth === undefined ? {} : { maxPagesPerMonth: body.maxPagesPerMonth }),
      ...(body.restartFrom === undefined ? {} : { restartFrom: body.restartFrom }),
      ...(body.force === undefined ? {} : { force: body.force }),
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/ghl-backfill")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
