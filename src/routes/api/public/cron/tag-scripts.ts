import { createFileRoute } from "@tanstack/react-router";

/**
 * Tags any script that carries text and has no tag row yet, then re-clusters
 * the tagged scripts into proposed concepts. Both steps only ever propose —
 * every row lands unconfirmed in the review queue.
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { retag_all?: boolean; limit?: number } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text) as typeof body;
  } catch {
    body = {};
  }

  try {
    const { tagScripts, proposeConcepts } = await import("@/lib/script-tagging.server");
    const tags = await tagScripts({
      retagAll: body.retag_all === true,
      ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
    });
    const concepts = await proposeConcepts();
    return Response.json({ tags, concepts }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { status: "error", error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const Route = createFileRoute("/api/public/cron/tag-scripts")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
