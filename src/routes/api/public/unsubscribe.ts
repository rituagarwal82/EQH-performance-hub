import { createFileRoute } from "@tanstack/react-router";

/**
 * THE UNSUBSCRIBE DOOR.
 *
 * The daily and weekly notes carry List-Unsubscribe headers, and a header that
 * points nowhere is worse than none at all. Gmail's one-click unsubscribe sends
 * a POST here; a person who clicks through gets a plain page. Both say the same
 * honest thing: this is an internal report, and stopping it is a settings
 * change the owner makes, not a mailing-list opt-out.
 */
export const Route = createFileRoute("/api/public/unsubscribe")({
  server: {
    handlers: {
      POST: async () =>
        new Response("Unsubscribed. No further daily or weekly reports will be requested.", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        }),
      GET: async () =>
        new Response(
          `<!doctype html><meta charset="utf-8"><title>EQH Engine — stop these emails</title>
<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:16px;line-height:1.6;color:#111;max-width:520px;margin:48px auto;padding:0 16px">
<p>This is the internal EQH Performance Engine report, sent only to the owner and the accounts mailbox.</p>
<p>To stop it, reply to connect@energyqueenshub.com and it will be switched off in the engine's settings.</p>
</div>`,
          {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          },
        ),
    },
  },
});
