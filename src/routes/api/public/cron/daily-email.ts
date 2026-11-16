import { createFileRoute } from "@tanstack/react-router";

/**
 * DAILY: the owner's status email, 6 p.m. India time (12:30 UTC) — after the
 * collections, team register, checks, signed-figure and analyst jobs.
 *
 * The 13:00 UTC job calls the same door: if the 12:30 UTC send succeeded it exits
 * as "already sent", so the retry can never produce a second email.
 */
export const Route = createFileRoute("/api/public/cron/daily-email")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { isCronAuthorized } = await import("@/lib/cron-auth.server");
        if (!isCronAuthorized(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        try {
          const { sendDailyEmail } = await import("@/lib/daily-email.server");
          // "Send it to me now" passes force=1; the schedule never does.
          const qs = new URL(request.url).searchParams;
          const force = qs.get("force") === "1";
          const date = qs.get("date");
          const businessDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined;
          const lateNote = qs.get("late")?.slice(0, 300) || undefined;
          const out = await sendDailyEmail({ force, businessDate, lateNote });
          // A missing key is a waiting state, not a failure: the job did its
          // work and the app shows why nothing went out.
          const status =
            out.status === "sent" || out.status === "already_sent"
              ? "success"
              : out.status === "no_key"
                ? "success_no_yield"
                : "error";
          return Response.json(
            {
              status,
              email: out.status,
              business_date: out.businessDate,
              message_id: out.messageId ?? null,
              dropped_attention: out.droppedAttention ?? [],
              image_count: out.imageCount ?? null,
              html_bytes: out.htmlBytes ?? null,
              error: out.error,
            },
            {
              status: out.status === "failed" ? 500 : 200,
              headers: { "Cache-Control": "no-store" },
            },
          );
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 500, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
      // Read-only: exactly what the email would say right now, without sending.
      GET: async ({ request }) => {
        const { isCronAuthorized } = await import("@/lib/cron-auth.server");
        if (!isCronAuthorized(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const { composeDailyEmail } = await import("@/lib/daily-email.server");
        return Response.json(await composeDailyEmail(), {
          headers: { "Cache-Control": "no-store" },
        });
      },
    },
  },
});
