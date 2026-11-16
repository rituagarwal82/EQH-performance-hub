/**
 * Scheduled-job routes (/api/public/*) require a dedicated secret in the
 * `x-cron-secret` header. pg_cron sends it through public.cron_post(), which
 * reads it from Supabase Vault (secret name `cron_secret`).
 *
 * Accepted secrets: env CRON_SECRET (new) or LOVABLE_CRON_SECRET (older name).
 *
 * TRANSITION ONLY: until CRON_SECRET is configured, the old behaviour (the
 * publishable key in an `apikey` header) is still accepted so the jobs keep
 * running. That key is public (it ships in the browser bundle), so set
 * CRON_SECRET as soon as the Vault secret exists — setting it switches the
 * publishable-key path off with no code change.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isCronAuthorized(request: Request) {
  const provided = request.headers.get("x-cron-secret");
  const newSecret = process.env["CRON_SECRET"];
  const oldSecret = process.env["LOVABLE_CRON_SECRET"];
  if (provided) {
    if (newSecret && safeEqual(provided, newSecret)) return true;
    if (oldSecret && safeEqual(provided, oldSecret)) return true;
  }

  // Temporary fallback — closed automatically once CRON_SECRET is set.
  if (newSecret) return false;
  const anon =
    process.env["SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["SUPABASE_ANON_KEY"] ??
    process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
  const apikey = request.headers.get("apikey");
  return Boolean(anon && apikey && apikey === anon);
}
