import { createFileRoute } from "@tanstack/react-router";

/**
 * Daily cron entry point for the Meta sync.
 *
 * Scheduling: point a daily scheduler (pg_cron / external scheduler) at
 *   POST https://<project>.lovable.app/api/public/cron/sync-meta
 *   header: x-cron-secret: <LOVABLE_CRON_SECRET>
 * Body is optional: {"since":"2026-01-01","until":"2026-08-26"} for backfills.
 * With no body it re-pulls a rolling 8-day window.
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let since: string | null = null;
  let until: string | null = null;
  let accountIds: string[] | null = null;
  try {
    const raw = await request.text();
    if (raw) {
      const parsed = JSON.parse(raw) as { since?: string; until?: string; accountIds?: string[] };
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      if (parsed.since && dateRe.test(parsed.since)) since = parsed.since;
      if (parsed.until && dateRe.test(parsed.until)) until = parsed.until;
      if (Array.isArray(parsed.accountIds)) {
        const ids = parsed.accountIds.filter((v) => typeof v === "string" && /^\d+$/.test(v));
        if (ids.length) accountIds = ids;
      }
    }
  } catch {
    // no body / not JSON — fall back to the rolling window
  }

  const { runGuardedJob, guardedResponse } = await import("@/lib/cron-job.server");
  const outcome = await runGuardedJob("meta-sync", async () => {
    const { runMetaSync } = await import("@/lib/meta-sync.server");

    // Daily grain: account, campaign and ad set for the whole window. Ad level is
    // bounded to the current and previous month — the owner needs per-ad detail
    // recently, and pulling it for all history would multiply the row count for
    // data nobody reads.
    const result = await runMetaSync({
      since,
      until,
      source: "cron",
      levels: ["account", "campaign", "adset"],
      accountIds,
      // Account discovery belongs to this pass alone, once per cycle, even when
      // the run is narrowed to named accounts.
      discover: true,
    });

    const now = new Date();
    const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 10);
    const adSince = since && since > prevMonthStart ? since : prevMonthStart;
    // A backfill that ends before the ad window starts has no ad grain to pull —
    // asking anyway makes Meta reject since > until.
    const adResult =
      until && until < adSince
        ? {
            status: "success" as const,
            rowsWritten: 0,
            skipped: `ad level skipped: window ends ${until}, before the ad-grain start ${adSince}`,
          }
        : await runMetaSync({
            since: adSince,
            until,
            source: "cron-ads",
            levels: ["ad"],
            accountIds,
            discover: false,
          });

    // Handover watch: tag Parami's entities, flag its first spend, and ask the
    // owner about any other new spend inside a closed (old ScaleX) account.
    let handover: unknown = null;
    try {
      const { getPg, pgRpc } = await import("@/lib/pg.server");
      const pg = getPg();
      if (pg) handover = await pgRpc(pg, "check_ad_account_handover", {});
    } catch (e) {
      console.error("[EQH] handover check failed:", e);
    }

    return {
      ...result,
      adLevel: adResult,
      handover,
      status:
        result.status === "error" || adResult.status === "error"
          ? result.status === "error" && adResult.status === "error"
            ? "error"
            : "partial"
          : result.status === "partial" || adResult.status === "partial"
            ? "partial"
            : "success",
    };

  });

  return guardedResponse(outcome);
}


export const Route = createFileRoute("/api/public/cron/sync-meta")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
    },
  },
});
