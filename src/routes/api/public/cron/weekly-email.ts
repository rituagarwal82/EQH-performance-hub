import { createFileRoute } from "@tanstack/react-router";

/**
 * MONDAY: the weekly note, sent after the daily email. Same honesty rules; a
 * missing email key is a waiting state, not a failure.
 */
export const Route = createFileRoute("/api/public/cron/weekly-email")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { isCronAuthorized } = await import("@/lib/cron-auth.server");
        if (!isCronAuthorized(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        try {
          const { sendWeeklyEmail } = await import("@/lib/weekly-email.server");
          const out = await sendWeeklyEmail();
          const status =
            out.status === "sent" || out.status === "already_sent"
              ? "success"
              : out.status === "no_key"
                ? "success_no_yield"
                : "error";
          return Response.json(
            { status, email: out.status, error: out.error },
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
      // Read-only: exactly what Monday's note would say right now.
      GET: async ({ request }) => {
        const { isCronAuthorized } = await import("@/lib/cron-auth.server");
        if (!isCronAuthorized(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const { composeWeeklyEmail } = await import("@/lib/weekly-email.server");
        return Response.json(await composeWeeklyEmail(), {
          headers: { "Cache-Control": "no-store" },
        });
      },
    },
  },
});
