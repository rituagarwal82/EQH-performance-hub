/**
 * Ad-account auto-discovery.
 *
 * WHY: account registration used to be a one-time snapshot taken at setup, so
 * an account activated later was invisible to the whole engine — no spend, no
 * ratios, and no signal that anything was missing. This enumerates every ad
 * account the token can see on each sync run and reconciles it with
 * ad_accounts.
 *
 * TWO LAWS HERE:
 *  1. The team (agency_code) is NEVER guessed from an account name. A new
 *     account is registered with agency_code NULL and raises a review item so
 *     a human assigns it. A wrong guess would silently corrupt per-team money.
 *  2. An account that stops being visible to the token is MARKED, never
 *     deleted — its historical rows stay valid and must keep rendering.
 */

import { getPg, pgInsert, pgSelect, pgUpdate, type PgClient } from "./pg.server";
import { graphGet } from "./meta-sync.server";
import { safeMessage } from "./safe-error";

export type DiscoveryResult = {
  status: "success" | "error";
  visible: number;
  registered: string[];
  reappeared: string[];
  vanished: string[];
  reviewItems: number;
  error: string | null;
};

type MetaAdAccount = {
  id?: string;
  account_id?: string;
  name?: string;
  account_status?: number;
  currency?: string;
};

/** Meta's numeric account_status → the label we store. */
function statusLabel(code: number | undefined) {
  switch (code) {
    case 1:
      return "active";
    case 2:
      return "disabled";
    case 3:
      return "unsettled";
    case 7:
      return "pending_risk_review";
    case 8:
      return "pending_settlement";
    case 9:
      return "in_grace_period";
    case 100:
      return "pending_closure";
    case 101:
      return "closed";
    case 201:
      return "any_active";
    case 202:
      return "any_closed";
    default:
      return code === undefined ? "unknown" : `status_${code}`;
  }
}

/** List every ad account the token can see. Throws with Meta's exact message. */
export async function listVisibleAccounts(token: string) {
  const rows: MetaAdAccount[] = [];
  let page = await graphGet<{ data: MetaAdAccount[]; paging?: { next?: string } }>(
    "/me/adaccounts",
    { fields: "account_id,name,account_status,currency", limit: "200" },
    token,
  );
  rows.push(...(page.data ?? []));
  let next = page.paging?.next ?? null;
  let guard = 0;
  while (next && guard++ < 50) {
    const res = await fetch(next);
    page = (await res.json()) as typeof page;
    rows.push(...(page.data ?? []));
    next = page.paging?.next ?? null;
  }
  return rows.filter((r) => r.account_id);
}

async function raiseReviewItem(pg: PgClient, accountId: string, name: string) {
  const existing = await pgSelect<{ id: string }[]>(
    pg,
    `/review_items?select=id&kind=eq.new_ad_account&ref_id=eq.${encodeURIComponent(accountId)}&status=eq.open`,
  );
  if (existing?.length) return false;
  await pgInsert(pg, "review_items", {
    kind: "new_ad_account",
    ref_id: accountId,
    title: `New ad account detected: ${name} (${accountId}) — assign team`,
    detail:
      "This account became visible to our Meta token and has been registered and switched on for syncing. " +
      "Its team (agency code) is unassigned — the engine never guesses a team from an account name, because a wrong " +
      "guess silently corrupts per-team money. Assign the team so its spend joins the right ratios.",
    evidence: { account_id: accountId, name, detected_at: new Date().toISOString() },
    status: "open",
  });
  return true;
}

/**
 * Reconcile ad_accounts against what the token can see.
 * Never throws into the caller's sync — returns an error result instead.
 *
 * `probe` exists only so the new-account path can be rehearsed on demand with a
 * supplied account list: it skips the vanish sweep and the patching of known
 * rows, so nothing real is touched while the register + review-item branch runs
 * for real. Normal sync calls never pass it.
 */
export async function runAccountDiscovery(
  token: string,
  probe?: { accounts: MetaAdAccount[] },
): Promise<DiscoveryResult> {
  const base: DiscoveryResult = {
    status: "error",
    visible: 0,
    registered: [],
    reappeared: [],
    vanished: [],
    reviewItems: 0,
    error: null,
  };
  const pg = getPg();
  if (!pg) return { ...base, error: "Lovable Cloud backend is not configured for this project yet." };

  let visible: MetaAdAccount[];
  if (probe) {
    visible = probe.accounts;
  } else {
    try {
      visible = await listVisibleAccounts(token);
    } catch (e) {
      return { ...base, error: safeMessage(e) };
    }
  }

  const known =
    (await pgSelect<{ account_id: string; name: string; status: string | null; is_active: boolean }[]>(
      pg,
      "/ad_accounts?select=account_id,name,status,is_active",
    )) ?? [];
  const knownById = new Map(known.map((k) => [k.account_id, k]));

  const registered: string[] = [];
  const reappeared: string[] = [];
  let reviewItems = 0;

  for (const acct of visible) {
    const id = acct.account_id!;
    const name = acct.name ?? `Ad account ${id}`;
    const status = statusLabel(acct.account_status);
    const row = knownById.get(id);
    if (!row) {
      await pgInsert(pg, "ad_accounts", {
        account_id: id,
        name,
        currency: acct.currency ?? "INR",
        status,
        is_active: true,
        agency_code: null, // never guessed — a human assigns it
        lead_tracking_status: "unknown",
      });
      registered.push(id);
      if (await raiseReviewItem(pg, id, name)) reviewItems += 1;
      continue;
    }
    if (probe) continue;
    const patch: Record<string, unknown> = {};
    if (row.name !== name) patch["name"] = name;
    if (row.status !== status) patch["status"] = status;
    // A previously vanished account that Meta shows again is visible once more.
    if (row.status === "not_visible_to_token") reappeared.push(id);
    if (Object.keys(patch).length) {
      await pgUpdate(pg, "ad_accounts", `account_id=eq.${encodeURIComponent(id)}`, patch);
    }
  }

  // Anything active in our table that the token can no longer see: mark it,
  // never delete it — its history stays valid and must keep rendering.
  const visibleIds = new Set(visible.map((v) => v.account_id));
  const vanished: string[] = [];
  for (const row of probe ? [] : known) {
    if (visibleIds.has(row.account_id)) continue;
    if (row.status === "not_visible_to_token") continue;
    await pgUpdate(pg, "ad_accounts", `account_id=eq.${encodeURIComponent(row.account_id)}`, {
      status: "not_visible_to_token",
    });
    vanished.push(row.account_id);
  }

  return {
    status: "success",
    visible: visible.length,
    registered,
    reappeared,
    vanished,
    reviewItems,
    error: null,
  };
}
