/**
 * Cron endpoints accept either the project's publishable (anon) key in an
 * `apikey` header — the pattern pg_cron uses — or an explicit x-cron-secret.
 */
export function isCronAuthorized(request: Request) {
  const secret = process.env["LOVABLE_CRON_SECRET"];
  if (secret && request.headers.get("x-cron-secret") === secret) return true;

  const anon =
    process.env["SUPABASE_PUBLISHABLE_KEY"] ??
    process.env["SUPABASE_ANON_KEY"] ??
    process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
  const provided = request.headers.get("apikey");
  return Boolean(anon && provided && provided === anon);
}
