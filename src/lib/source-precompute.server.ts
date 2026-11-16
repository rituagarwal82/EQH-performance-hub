/**
 * REFRESHING THE STORED SOURCE ATTRIBUTION.
 *
 * The Sources screen used to work out first-touch attribution for every lead
 * on every page view, which took longer than the API would wait. The answer is
 * now stored once per sale and per month, and refreshed here: after a ledger
 * sync, after any source rebuild or dictionary change, and nightly.
 *
 * Never fatal: a refresh that fails leaves the previous (dated) answer in
 * place rather than breaking the screen.
 */

import { getPg, pgRpc } from "./pg.server";
import { safeMessage } from "./safe-error";

export type SourcePrecomputeResult = {
  status: "success" | "error" | "skipped";
  sales?: number;
  lead_rows?: number;
  agency_rows?: number;
  agency_error?: string;
  rebuilt_at?: string;
  duration_ms?: number;
  error?: string;
};

export async function refreshSourcePrecompute(): Promise<SourcePrecomputeResult> {
  const pg = getPg();
  if (!pg) return { status: "skipped", error: "backend not configured" };
  const t0 = Date.now();
  try {
    // Any lead still without a source decision is settled first, so the stored
    // sales below can never inherit a gap: an unresolved lead reads as
    // "No lead record" on its sale and its team gets no credit.
    try {
      await pgRpc<number>(pg, "resolve_unified_source_incremental", { p_window: "2 hours" });
    } catch (e) {
      console.error("[EQH] incremental source resolve failed:", safeMessage(e));
    }

    // The two halves are run separately: each finishes in a few seconds, while
    // the pair in one statement sat close to the request limit.
    const sales = await pgRpc<number>(pg, "rebuild_sale_attribution", {});
    const leadRows = await pgRpc<number>(pg, "rebuild_lead_source_month", {});

    // The agency report reads the attribution just rebuilt above, so it is
    // refreshed in the same pass. A failure here leaves the previous (dated)
    // agency figures in place rather than losing the source rebuild.
    let agencyRows: number | undefined;
    let agencyError: string | undefined;
    try {
      agencyRows = Number((await pgRpc<number>(pg, "rebuild_agency_report", {})) ?? 0);
    } catch (e) {
      agencyError = safeMessage(e);
      console.error("[EQH] agency report refresh failed:", agencyError);
    }

    return {
      status: "success",
      sales: Number(sales ?? 0),
      lead_rows: Number(leadRows ?? 0),
      ...(agencyRows === undefined ? {} : { agency_rows: agencyRows }),
      ...(agencyError === undefined ? {} : { agency_error: agencyError }),
      rebuilt_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
    };
  } catch (e) {
    console.error("[EQH] source precompute refresh failed:", safeMessage(e));
    return { status: "error", error: safeMessage(e), duration_ms: Date.now() - t0 };
  }
}
