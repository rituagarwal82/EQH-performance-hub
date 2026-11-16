/**
 * The signed-in + owner check used by the app's server-function gate.
 *
 * 1. Bearer-token validation (the same check the generated Supabase middleware
 *    performs).
 * 2. The token's email must be on the owner allow-list, which is DATA in the
 *    `owner_emails` table (service-role only; add or remove a row to change who
 *    may use the hub). Anything unreadable fails closed.
 */
import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import { getPg, pgSelect } from "./pg.server";

const OWNER_TTL_MS = 60_000;
const ownerCache = new Map<string, { ok: boolean; at: number }>();

async function verifyToken(): Promise<{ sub: string; email: string | null }> {
  const SUPABASE_URL = process.env["SUPABASE_URL"];
  const SUPABASE_PUBLISHABLE_KEY = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Missing Supabase environment variables.");
  }

  const request = getRequest();
  const authHeader = request?.headers?.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Unauthorized: No authorization header provided");
  }
  const token = authHeader.slice("Bearer ".length);
  if (!token || token.split(".").length !== 3) {
    throw new Error("Unauthorized: Invalid token");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims?.sub) {
    throw new Error("Unauthorized: Invalid token");
  }
  const rawEmail = (data.claims as { email?: unknown }).email;
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : null;
  return { sub: String(data.claims.sub), email };
}

async function isOwnerEmail(email: string): Promise<boolean> {
  const hit = ownerCache.get(email);
  if (hit && Date.now() - hit.at < OWNER_TTL_MS) return hit.ok;
  const pg = getPg();
  if (!pg) return false;
  try {
    const rows = await pgSelect<{ email: string }[]>(
      pg,
      `/owner_emails?select=email&email=eq.${encodeURIComponent(email)}&limit=1`,
    );
    const ok = Array.isArray(rows) && rows.length > 0;
    ownerCache.set(email, { ok, at: Date.now() });
    return ok;
  } catch {
    // Fail closed: an unreadable allow-list must never let anyone in.
    return false;
  }
}

/** Throws unless the caller is signed in. */
export async function requireSignedIn(): Promise<void> {
  await verifyToken();
}

/** Throws unless the caller is signed in AND on the owner allow-list. */
export async function requireOwner(): Promise<void> {
  const { email } = await verifyToken();
  if (!email || !(await isOwnerEmail(email))) {
    throw new Error("Unauthorized: this account is not allowed to use the hub");
  }
}
