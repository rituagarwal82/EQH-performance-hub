/**
 * TEMPORARY BUILD SWITCH (owner instruction, 11 Sep 2026).
 *
 * `app_settings.open_access = 'true'` lets the app load with no sign-in while
 * it is being built. Anything else — missing row, 'false', unreadable — keeps
 * the normal email one-time-code gate exactly as it was. Nothing about the
 * /auth screen or the Supabase auth config is removed; this only decides
 * whether the gate is consulted.
 */
import { getPg, pgSelect } from "./pg.server";

const TTL_MS = 30_000;
let cache: { value: boolean; at: number } | null = null;

export async function isOpenAccess(): Promise<boolean> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const pg = getPg();
  if (!pg) return false;
  try {
    const rows = await pgSelect<{ value: string | null }[]>(
      pg,
      "/app_settings?select=value&key=eq.open_access&limit=1",
    );
    const value = String(rows[0]?.value ?? "").trim().toLowerCase() === "true";
    cache = { value, at: Date.now() };
    return value;
  } catch {
    // Fail closed: an unreadable setting must never open the app.
    return false;
  }
}
