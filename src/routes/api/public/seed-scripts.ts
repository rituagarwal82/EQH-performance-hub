import { createFileRoute } from "@tanstack/react-router";
import { safeMessage } from "@/lib/safe-error";

/**
 * Script seed ingestion — service-role only.
 *
 *   POST /api/public/seed-scripts
 *   header: x-cron-secret: <LOVABLE_CRON_SECRET>   (or apikey: <publishable key>)
 *   body:   [{ "script_code": "V1", "title": "...", "script_text": "..." }, ...]
 *
 * Upserts on script_code. Rows missing a code or text are skipped, never
 * invented.
 */
async function handle(request: Request) {
  const { isCronAuthorized } = await import("@/lib/cron-auth.server");
  if (!isCronAuthorized(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let rows: unknown;
  try {
    rows = JSON.parse(await request.text());
  } catch {
    return json({ error: "Body must be a JSON array of scripts." }, 400);
  }
  const list = Array.isArray(rows) ? rows : (rows as { scripts?: unknown })?.scripts;
  if (!Array.isArray(list)) {
    return json({ error: "Body must be a JSON array of {script_code, title, script_text}." }, 400);
  }

  const clean = list.filter(
    (r): r is Record<string, unknown> =>
      Boolean(r) &&
      typeof r === "object" &&
      typeof (r as Record<string, unknown>)["script_code"] === "string" &&
      typeof (r as Record<string, unknown>)["script_text"] === "string",
  );
  const skipped = list.length - clean.length;

  const { getPg, pgRpc } = await import("@/lib/pg.server");
  const pg = getPg();
  if (!pg) return json({ error: "Backend not configured." }, 500);

  try {
    let written = 0;
    for (let i = 0; i < clean.length; i += 200) {
      written += await pgRpc<number>(pg, "upsert_creative_scripts", {
        p_rows: clean.slice(i, i + 200),
        p_source: "doc_seed",
      });
    }
    return json({ status: "success", received: list.length, written, skipped });
  } catch (e) {
    return json({ error: safeMessage(e) }, 500);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/seed-scripts")({
  server: { handlers: { POST: ({ request }) => handle(request) } },
});
