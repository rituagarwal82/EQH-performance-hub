import { createServerFn } from "@tanstack/react-start";

/**
 * Tells the browser whether the temporary open-access build switch is on.
 * When the switch is off and nobody is signed in, the global gate rejects this
 * call — the route treats that rejection as "locked" and shows the sign-in
 * screen, exactly as before.
 */
export const getAccessMode = createServerFn({ method: "GET" }).handler(async () => {
  const { isOpenAccess } = await import("./open-access.server");
  return { open: await isOpenAccess() };
});
