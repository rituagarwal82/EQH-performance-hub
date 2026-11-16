import { createFileRoute } from "@tanstack/react-router";

/**
 * Sabhi Digital daily report. POST sends (once per period, refusals enforced);
 * GET ?date=YYYY-MM-DD returns the composed email without sending anything.
 */
export const Route = createFileRoute("/api/public/cron/agency-daily")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { isCronAuthorized } = await import("@/lib/cron-auth.server");
        if (!isCronAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
        try {
          const m = await import("@/lib/agency-email.server");
          const { yesterdayIst } = await import("@/lib/daily-email.server");
          const composed = await m.composeAgencyDaily(yesterdayIst());
          const out = await m.sendAgencyEmail(composed);
          const status =
            out.status === "sent" || out.status === "already_sent" ? "success"
              : out.status === "no_key" ? "success_no_yield" : "error";
          return Response.json(
            { status, email: out.status, message_id: out.messageId, error: out.error },
            { status: out.status === "failed" || out.status === "refused" ? 500 : 200, headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 500, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
      GET: async ({ request }) => {
        const { isCronAuthorized } = await import("@/lib/cron-auth.server");
        if (!isCronAuthorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
        const date = new URL(request.url).searchParams.get("date");
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return Response.json({ error: "date=YYYY-MM-DD required" }, { status: 400 });
        }
        const m = await import("@/lib/agency-email.server");
        return Response.json(await m.composeAgencyDaily(date), { headers: { "Cache-Control": "no-store" } });
      },
    },
  },
});
