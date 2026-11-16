import { createMiddleware } from "@tanstack/react-start";

/**
 * Global server-function gate.
 *
 * Normally: every server function requires the signed-in user's bearer token.
 * While the temporary `app_settings.open_access = 'true'` switch is on: the
 * check is skipped so the app can be built without signing in. Flip the
 * setting back to 'false' and the original behaviour returns with no code
 * change.
 */
export const authGate = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const { isOpenAccess } = await import("./open-access.server");
  if (await isOpenAccess()) return next();
  const { requireSignedIn } = await import("./auth-verify.server");
  await requireSignedIn();
  return next();
});
