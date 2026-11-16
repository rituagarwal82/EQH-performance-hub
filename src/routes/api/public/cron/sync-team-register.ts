import { createFileRoute } from "@tanstack/react-router";

/**
 * Daily import of the team's source register sheet, run just after the ledger
 * sync so the day's new sales already exist when the register is matched.
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { runGuardedJob, guardedResponse } = await import("@/lib/cron-job.server");
    const { runTeamRegisterSync } = await import("@/lib/team-register-sheet.server");
    const outcome = await runGuardedJob("team-register", () => runTeamRegisterSync());
    return guardedResponse(outcome);
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/sync-team-register")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
