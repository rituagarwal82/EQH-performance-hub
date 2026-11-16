/**
 * The signed-in check used by the app's server-function gate. It is the same
 * bearer-token validation the generated Supabase middleware performs; it lives
 * here so the gate can be skipped when the temporary open-access switch is on
 * (see open-access.server.ts) without editing generated files.
 */
import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";

export async function requireSignedIn(): Promise<void> {
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
}
