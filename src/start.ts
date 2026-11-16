import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { attachSupabaseAuth } from "./integrations/supabase/auth-attacher";
import { authGate } from "./lib/auth-gate";
import { renderErrorPage } from "./lib/error-page";


const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Start installs this automatically when src/start.ts is absent; defining the
// file opts out, so re-add it explicitly. It covers server functions AND the
// app's own /api handlers — previously only server functions were protected.
// Two exemptions: ordinary page requests (a document GET is not a cross-site
// write), and the scheduled-job routes under /api/public, which are called from
// outside a browser entirely and carry their own key check (cron-auth.server).
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => {
    if (ctx.handlerType === "serverFn") return true;
    try {
      const path = new URL(ctx.request.url).pathname;
      return path.startsWith("/api/") && !path.startsWith("/api/public/");
    } catch {
      return false;
    }
  },
});

// Every server function is internal: the browser attaches the signed-in user's
// token (attachSupabaseAuth) and the server refuses the call without a valid one
// unless that user's email is on the owner allow-list (authGate, owner_emails
// table). Scheduled jobs never come through here — they call the /api/public
// routes with their own secret (cron-auth.server).
export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware, csrfMiddleware],
  functionMiddleware: [attachSupabaseAuth, authGate],
}));


