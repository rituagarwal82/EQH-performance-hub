/**
 * Owner controls for the shared job stand-down.
 *
 * When a heavy job exhausts its retries, every heavy job stands down for a
 * cool-off. Before this existed the only ways back were waiting twenty minutes
 * or editing a settings row by hand — so an owner staring at a stalled pipeline
 * had nothing to press. Now they do.
 */

import { createServerFn } from "@tanstack/react-start";

export const getJobStandDown = createServerFn({ method: "GET" }).handler(async () => {
  const { getPg } = await import("./pg.server");
  const { breakerState } = await import("./load-guard.server");
  const pg = getPg();
  if (!pg) return { open: false, until: null, reason: null } as const;
  return breakerState(pg);
});

export const clearJobStandDown = createServerFn({ method: "POST" }).handler(async () => {
  const { getPg } = await import("./pg.server");
  const { clearBreaker, breakerState } = await import("./load-guard.server");
  const pg = getPg();
  if (!pg) return { cleared: false, state: { open: false, until: null, reason: null } };
  await clearBreaker(pg);
  return { cleared: true, state: await breakerState(pg) };
});
