import { createMiddleware } from "@tanstack/react-start";

/**
 * Global server-function gate.
 *
 * Every server function requires (1) a valid signed-in bearer token and
 * (2) that the signed-in email is on the owner allow-list held in the
 * `owner_emails` table. The old `app_settings.open_access` build switch is no
 * longer consulted (security fix, 16 Nov 2026): the hub holds the cash ledger,
 * buyers and spend, so it must never open without sign-in.
 */
export const authGate = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const { requireOwner } = await import("./auth-verify.server");
  await requireOwner();
  return next();
});
