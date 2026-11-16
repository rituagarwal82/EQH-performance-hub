import { createFileRoute } from "@tanstack/react-router";

async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    since?: string | null;
    limit?: number;
    probeLatest?: boolean;
    oldestFirst?: boolean;
  } = {};

  try {
    const text = await request.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }

  if (body.probeLatest) {
    const { probeLatestRecording } = await import("@/lib/zoom-recordings.server");
    const probe = await probeLatestRecording({ since: body.since ?? null });
    return Response.json(probe, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const { runRecordingCapture } = await import("@/lib/zoom-recordings.server");
    const result = await runRecordingCapture({
      since: body.since ?? null,
      ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
      ...(body.oldestFirst === undefined ? {} : { oldestFirst: body.oldestFirst }),
      source: "zoom-recordings-cron",
    });

    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/capture-recordings")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
