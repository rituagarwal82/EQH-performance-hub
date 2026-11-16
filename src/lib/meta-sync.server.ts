/**
 * Meta Ads → daily_metrics sync.
 *
 * The access token is read from the META_ACCESS_TOKEN secret at call time and
 * is never stored in code. If it is missing the run fails cleanly and records
 * an explanatory row in sync_runs.
 *
 * VALIDATION TARGET — after a full 2026 backfill, total Meta spend across all
 * accounts per month should land close to:
 *   Jan ₹21,27,663 · Feb ₹24,17,683 · Mar ₹44,75,910 · Apr ₹33,91,244
 *   May ₹28,17,798 · Jun ₹23,38,455 · Jul ₹15,72,085 · Aug (to 26th) ₹8,06,404
 *   2026 total ≈ ₹1.99 crore
 * If the pipeline drifts materially from these, it is not honest — investigate
 * before trusting anything downstream.
 */

import { getPg, pgInsert, pgRpc, pgSelect, pgUpdate, type PgClient } from "./pg.server";
import { analyzeAfterWrite } from "./load-guard.server";
import { lastRawError, safeMessage } from "./safe-error";

const GRAPH = "https://graph.facebook.com/v21.0";

export type SyncResult = {
  status: "success" | "partial" | "error";
  rowsWritten: number;
  entitiesWritten: number;
  accountsSynced: number;
  since: string;
  until: string;
  error: string | null;
  accountErrors: { account_id: string; message: string }[];
  /** Auto-discovery outcome for this run; null when discovery was skipped. */
  discovery?: {
    visible: number;
    registered: string[];
    vanished: string[];
    error: string | null;
  } | null;
};


type AccountRow = { account_id: string; name: string; agency_code: string | null };

type MetaAction = { action_type: string; value: string };

type MetaInsight = {
  date_start: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  actions?: MetaAction[];
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
};

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function actionValue(actions: MetaAction[] | undefined, type: string) {
  if (!actions) return 0;
  const hit = actions.find((a) => a.action_type === type);
  return hit ? Math.round(Number(hit.value) || 0) : 0;
}

const THROTTLE_CODES = new Set([17, 613, 4, 80000]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type MetaError = { message?: string; code?: number };

/** GET with exponential backoff on Meta throttling (codes 17 / 613), 3 retries. */
async function graphFetch<T>(url: string): Promise<T> {
  let attempt = 0;
  for (;;) {
    const res = await fetch(url);
    const body = (await res.json()) as { error?: MetaError } & T;
    const err = body?.error;
    if (!res.ok || err) {
      const code = err?.code ?? 0;
      const throttled = THROTTLE_CODES.has(code) || res.status === 429;
      if (throttled && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        attempt += 1;
        continue;
      }
      throw new Error(
        `${err?.message ?? `Meta API error ${res.status}`}${throttled ? " (throttled, retries exhausted)" : ""}`,
      );
    }
    return body;
  }
}

export async function graphGet<T>(path: string, params: Record<string, string>, token: string) {
  const qs = new URLSearchParams({ ...params, access_token: token });
  return graphFetch<T>(`${GRAPH}${path}?${qs.toString()}`);
}

async function graphPaged<T>(path: string, params: Record<string, string>, token: string) {
  const out: T[] = [];
  let page = await graphGet<{ data: T[]; paging?: { next?: string } }>(path, params, token);
  out.push(...(page.data ?? []));
  let next: string | null = page.paging?.next ?? null;
  let guard = 0;
  while (next && guard++ < 200) {
    page = await graphFetch<{ data: T[]; paging?: { next?: string } }>(next);
    out.push(...(page.data ?? []));
    next = page.paging?.next ?? null;
  }
  return out;
}

function insightRow(
  accountId: string,
  level: "account" | "campaign" | "adset" | "ad",
  row: MetaInsight,
) {
  const entityId =
    level === "campaign"
      ? (row.campaign_id ?? null)
      : level === "adset"
        ? (row.adset_id ?? null)
        : level === "ad"
          ? (row.ad_id ?? null)
          : null;
  return {
    date: row.date_start,
    account_id: accountId,
    entity_id: entityId,
    level,
    placement: null,
    spend: Number(row.spend ?? 0),
    impressions: Number(row.impressions ?? 0),
    link_clicks: Number(row.inline_link_clicks ?? 0),
    landing_page_views: actionValue(row.actions, "landing_page_view"),
    leads: actionValue(row.actions, "lead"),
    purchases: actionValue(row.actions, "omni_purchase"),
  };
}

async function syncAccountInsightsAtLevel(
  pg: PgClient,
  accountId: string,
  token: string,
  since: string,
  until: string,
  level: "account" | "campaign" | "adset" | "ad",
) {
  let written = 0;
  // The id fields must be requested explicitly — without them Meta returns the
  // insight rows with no entity id, every campaign collapses onto one row per
  // day, and the grain the owner asked for silently disappears.
  const idFields =
    level === "campaign"
      ? ",campaign_id,campaign_name"
      : level === "adset"
        ? ",campaign_id,adset_id,adset_name"
        : level === "ad"
          ? ",campaign_id,adset_id,ad_id,ad_name"
          : "";
  const rows = await graphPaged<MetaInsight>(
    `/act_${accountId}/insights`,
    {
      fields: `spend,impressions,inline_link_clicks,actions${idFields}`,
      level,
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      limit: "500",
    },
    token,
  );
  if (!rows.length) return written;

  // Meta can return more than one insight row for the same ad on the same day
  // (it splits on attribution windows and on ad-set edits). Two such rows inside
  // one upsert batch trip Postgres 21000: "ON CONFLICT DO UPDATE command cannot
  // affect row a second time". Collapse them HERE, keyed exactly as the unique
  // index is - (date, account_id, COALESCE(entity_id,''), level, COALESCE(placement,'')) -
  // by summing the additive metrics. Dropping the extra row instead would lose
  // real spend, and DO NOTHING would lose it silently.
  const merged = new Map<string, ReturnType<typeof insightRow>>();
  for (const r of rows) {
    const row = insightRow(accountId, level, r);
    const key = [row.date, row.account_id, row.entity_id ?? "", row.level, row.placement ?? ""].join("\u0000");
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, row);
      continue;
    }
    prev.spend += row.spend;
    prev.impressions += row.impressions;
    prev.link_clicks += row.link_clicks;
    prev.landing_page_views += row.landing_page_views;
    prev.leads += row.leads;
    prev.purchases += row.purchases;

  }
  const payload = [...merged.values()];
  for (let i = 0; i < payload.length; i += 500) {
    written += await pgRpc<number>(pg, "upsert_daily_metrics", {
      p_rows: payload.slice(i, i + 500),
    });
  }

  return written;
}

async function syncAccountEntities(
  pg: PgClient,
  account: AccountRow,
  token: string,
): Promise<number> {
  const entities: Record<string, unknown>[] = [];

  const campaigns = await graphPaged<{ id: string; name: string; status: string }>(
    `/act_${account.account_id}/campaigns`,
    { fields: "id,name,status", limit: "500" },
    token,
  );
  for (const c of campaigns) {
    entities.push({
      entity_id: c.id,
      level: "campaign",
      account_id: account.account_id,
      parent_id: null,
      name: c.name,
      status: c.status,
      agency_code: account.agency_code,
    });
  }

  const adsets = await graphPaged<{
    id: string;
    name: string;
    status: string;
    campaign_id: string;
  }>(
    `/act_${account.account_id}/adsets`,
    { fields: "id,name,status,campaign_id", limit: "500" },
    token,
  );
  for (const s of adsets) {
    entities.push({
      entity_id: s.id,
      level: "adset",
      account_id: account.account_id,
      parent_id: s.campaign_id,
      name: s.name,
      status: s.status,
      agency_code: account.agency_code,
    });
  }

  const ads = await graphPaged<{ id: string; name: string; status: string; adset_id: string }>(
    `/act_${account.account_id}/ads`,
    { fields: "id,name,status,adset_id", limit: "500" },
    token,
  );
  for (const a of ads) {
    entities.push({
      entity_id: a.id,
      level: "ad",
      account_id: account.account_id,
      parent_id: a.adset_id,
      name: a.name,
      status: a.status,
      agency_code: account.agency_code,
    });
  }

  let written = 0;
  for (let i = 0; i < entities.length; i += 500) {
    written += await pgRpc<number>(pg, "upsert_ad_entities", {
      p_rows: entities.slice(i, i + 500),
    });
  }
  return written;
}

export async function runMetaSync(opts: {
  since?: string | null;
  until?: string | null;
  source: string;
  levels?: ("account" | "campaign" | "adset" | "ad")[];
  /** Restrict the run to specific ad accounts (e.g. onboarding one new account). */
  accountIds?: string[] | null;
  /**
   * Account auto-discovery. The nightly cron calls this function twice (daily
   * grain, then ad grain); discovery is a full enumeration of every visible ad
   * account, so the caller says explicitly which of its passes owns it —
   * exactly once per cycle, and never skipped just because the run was
   * narrowed to specific accounts.
   */
  discover?: boolean;

}): Promise<SyncResult> {
  const pg = getPg();
  const today = new Date();
  const start = new Date(today.getTime() - 8 * 24 * 60 * 60 * 1000);
  const since = opts.since ?? isoDate(start);
  const until = opts.until ?? isoDate(today);

  const base: SyncResult = {
    status: "error",
    rowsWritten: 0,
    entitiesWritten: 0,
    accountsSynced: 0,
    since,
    until,
    error: null,
    accountErrors: [],
  };

  if (!pg) {
    return { ...base, error: "Lovable Cloud backend is not configured for this project yet." };
  }

  const run = await pgInsert<{ id: string }[]>(pg, "sync_runs", {
    source: opts.source,
    status: "running",
  });
  const runId = run?.[0]?.id;

  const finish = async (result: SyncResult) => {
    // Planner statistics: a job never reports success on data the planner
    // still thinks is not there (7 Sep outage rule).
    if (result.rowsWritten > 0) await analyzeAfterWrite(pg, ["daily_metrics", "ad_entities", "ad_accounts"]);
    if (runId) {
      await pgUpdate(pg, "sync_runs", `id=eq.${runId}`, {
        finished_at: new Date().toISOString(),
        rows_written: result.rowsWritten,
        status: result.status,
        error: result.error,
        error_detail: result.error ? (lastRawError() ?? result.error) : null,
      });
    }
    return result;
  };

  const token = process.env["META_ACCESS_TOKEN"];
  if (!token) {
    return finish({
      ...base,
      error: "META_ACCESS_TOKEN is not set. Add it in Cloud secrets, then run the sync again.",
    });
  }

  // Auto-discovery runs BEFORE the account list is read, so an account that
  // appeared since the last run is synced in this very run rather than the
  // next one. A discovery failure never fails the sync.
  let discovery: SyncResult["discovery"] = null;
  if (opts.discover ?? !opts.accountIds) {
    const { runAccountDiscovery } = await import("./meta-discovery.server");
    const d = await runAccountDiscovery(token);
    discovery = {
      visible: d.visible,
      registered: d.registered,
      vanished: d.vanished,
      error: d.error,
    };
  }


  let accounts: AccountRow[] = [];
  try {
    accounts = await pgSelect<AccountRow[]>(
      pg,
      "/ad_accounts?select=account_id,name,agency_code&is_active=eq.true",
    );
  } catch (e) {
    return finish({ ...base, error: safeMessage(e) });
  }

  if (opts.accountIds && opts.accountIds.length) {
    const wanted = new Set(opts.accountIds);
    accounts = accounts.filter((a) => wanted.has(a.account_id));
  }


  let rowsWritten = 0;
  let entitiesWritten = 0;
  let accountsSynced = 0;
  const accountErrors: SyncResult["accountErrors"] = [];

  const levels = opts.levels ?? ["account", "campaign", "adset", "ad"];
  for (const account of accounts) {
    // Each level is attempted independently: a level Meta refuses for one
    // account must not silently take that account's other levels with it.
    let anyLevelSucceeded = false;
    const levelErrors: string[] = [];
    for (const level of levels) {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          rowsWritten += await syncAccountInsightsAtLevel(pg, account.account_id, token, since, until, level);
          anyLevelSucceeded = true;
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          const msg = safeMessage(e);
          // Meta's transient failures ("unknown error", "temporarily
          // unavailable") clear on a retry; anything else will not.
          if (!/unknown error|temporarily unavailable|rate limit|reduce the amount of data/i.test(msg)) break;
          await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        }
      }
      if (lastError) levelErrors.push(`${level}: ${(lastError as Error).message}`);
    }
    if (levels.some((level) => level !== "account")) {
      try {
        entitiesWritten += await syncAccountEntities(pg, account, token);
      } catch (e) {
        levelErrors.push(`entities: ${safeMessage(e)}`);
      }
    }
    if (anyLevelSucceeded) accountsSynced += 1;
    if (levelErrors.length) {
      accountErrors.push({ account_id: account.account_id, message: levelErrors.join("; ") });
    }
  }


  const status: SyncResult["status"] =
    accountErrors.length === 0 ? "success" : accountsSynced > 0 ? "partial" : "error";

  return finish({
    status,
    rowsWritten,
    entitiesWritten,
    accountsSynced,
    since,
    until,
    error: accountErrors.length
      ? accountErrors.map((a) => `${a.account_id}: ${a.message}`).join(" | ")
      : null,
    accountErrors,
    discovery,
  });
}
