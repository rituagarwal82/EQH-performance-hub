/**
 * Creative Intelligence — Phase A ingestion.
 *
 *   1. Creative TEXT per ad (body / title / thumbnail / object type) written
 *      onto ad_entities, with a per-ad fetch status. The Meta creatives edge
 *      has been flaky, so every call is retried with backoff and a failure is
 *      recorded as 'error' on the ad rather than left as silence.
 *   2. Age and gender breakdowns at ad level into demo_metrics. Meta allows one
 *      breakdown per insights call, so this is two passes.
 *
 * No LLM, no tagging, no persona work happens here — that follows the
 * specialist taxonomy design.
 */

import { getPg, pgRpc, pgSelect, pgUpsert, type PgClient } from "./pg.server";
import { graphGet } from "./meta-sync.server";
import { safeMessage } from "./safe-error";

type AccountRow = { account_id: string; name: string; agency_code: string | null };

type MetaCreative = {
  body?: string;
  title?: string;
  thumbnail_url?: string;
  object_type?: string;
  object_story_id?: string;
  effective_object_story_id?: string;
  instagram_permalink_url?: string;
  video_id?: string;
};

type MetaAdRow = {
  id: string;
  name?: string;
  status?: string;
  adset_id?: string;
  creative?: MetaCreative;
};

const CREATIVE_FIELDS =
  "creative{body,title,thumbnail_url,object_type,object_story_id,effective_object_story_id,instagram_permalink_url,video_id}";

/**
 * Where the owner can actually watch the ad. Meta only gives a public address
 * when the ad is a real page post or reel; otherwise there is nothing to link
 * to and the email falls back to Ads Manager rather than inventing a link.
 */
export function watchLink(c: MetaCreative | undefined): string | null {
  if (!c) return null;
  if (c.instagram_permalink_url) return c.instagram_permalink_url;
  const story = c.effective_object_story_id ?? c.object_story_id;
  if (story && story.includes("_")) {
    const [page, post] = story.split("_");
    if (page && post) return `https://www.facebook.com/${page}/posts/${post}`;
  }
  if (c.video_id) return `https://www.facebook.com/watch/?v=${c.video_id}`;
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withBackoff<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(1500 * 2 ** i);
    }
  }
  throw last as Error;
}

async function pagedAdsAt(accountId: string, token: string, limit: number) {
  const out: MetaAdRow[] = [];
  let page = await withBackoff(() =>
    graphGet<{ data: MetaAdRow[]; paging?: { next?: string } }>(
      `/act_${accountId}/ads`,
      {
        fields: `id,name,status,adset_id,${CREATIVE_FIELDS}`,
        limit: String(limit),
      },
      token,
    ),
  );
  out.push(...(page.data ?? []));
  let next = page.paging?.next ?? null;
  let guard = 0;
  while (next && guard++ < 2000) {
    const url: string = next;
    page = await withBackoff(async () => {
      const res = await fetch(url);
      const body = (await res.json()) as { data: MetaAdRow[]; paging?: { next?: string }; error?: { message?: string } };
      if (!res.ok || body.error) throw new Error(body.error?.message ?? `Meta error ${res.status}`);
      return body;
    });
    out.push(...(page.data ?? []));
    next = page.paging?.next ?? null;
  }
  return out;
}

/**
 * Meta answers "please reduce the amount of data you're asking for" on the
 * larger accounts. That is a page-size complaint, not an outage — step the page
 * size down rather than dropping the account's creative text silently.
 */
async function pagedAds(accountId: string, token: string) {
  const sizes = [200, 50, 15];
  let last: unknown;
  for (const size of sizes) {
    try {
      return await pagedAdsAt(accountId, token, size);
    } catch (e) {
      last = e;
      if (!/reduce the amount of data/i.test(safeMessage(e) ?? "")) throw e;
    }
  }
  throw last as Error;
}


export type CreativeTextResult = {
  status: "success" | "partial" | "error";
  accountsSynced: number;
  adsSeen: number;
  adsWithBody: number;
  adsWithTitle: number;
  adsFailed: number;
  accountErrors: { account_id: string; message: string }[];
  error: string | null;
};

export async function syncCreativeText(): Promise<CreativeTextResult> {
  const pg = getPg();
  const base: CreativeTextResult = {
    status: "error",
    accountsSynced: 0,
    adsSeen: 0,
    adsWithBody: 0,
    adsWithTitle: 0,
    adsFailed: 0,
    accountErrors: [],
    error: null,
  };
  if (!pg) return { ...base, error: "Lovable Cloud backend is not configured for this project yet." };
  const token = process.env["META_ACCESS_TOKEN"];
  if (!token) return { ...base, error: "META_ACCESS_TOKEN is not set." };

  const accounts = await pgSelect<AccountRow[]>(
    pg,
    "/ad_accounts?select=account_id,name,agency_code&is_active=eq.true",
  );

  let adsSeen = 0;
  let adsWithBody = 0;
  let adsWithTitle = 0;
  let adsFailed = 0;
  let accountsSynced = 0;
  const accountErrors: CreativeTextResult["accountErrors"] = [];

  for (const account of accounts ?? []) {
    let ads: MetaAdRow[];
    try {
      ads = await pagedAds(account.account_id, token);
    } catch (e) {
      accountErrors.push({ account_id: account.account_id, message: safeMessage(e) });
      await markAccountFetchError(pg, account.account_id, safeMessage(e));
      continue;
    }
    accountsSynced += 1;

    const rows = ads.map((a) => {
      const body = a.creative?.body?.trim() || null;
      const title = a.creative?.title?.trim() || null;
      if (body) adsWithBody += 1;
      if (title) adsWithTitle += 1;
      const hasAny = Boolean(body || title || a.creative?.thumbnail_url);
      if (!hasAny) adsFailed += 1;
      return {
        entity_id: a.id,
        level: "ad",
        account_id: account.account_id,
        parent_id: a.adset_id ?? null,
        name: a.name ?? null,
        status: a.status ?? null,
        agency_code: account.agency_code,
        creative_body: body,
        creative_title: title,
        thumbnail_url: a.creative?.thumbnail_url ?? null,
        permalink_url: watchLink(a.creative),
        creative_object_type: a.creative?.object_type ?? null,
        creative_fetch_status: hasAny ? "ok" : "empty",
        creative_fetch_error: null,
        creative_fetched_at: new Date().toISOString(),
      };
    });
    adsSeen += rows.length;

    for (let i = 0; i < rows.length; i += 200) {
      await pgUpsert(pg, "ad_entities", rows.slice(i, i + 200));
    }
  }

  const status: CreativeTextResult["status"] =
    accountErrors.length === 0 ? "success" : accountsSynced > 0 ? "partial" : "error";

  return {
    status,
    accountsSynced,
    adsSeen,
    adsWithBody,
    adsWithTitle,
    adsFailed,
    accountErrors,
    error: accountErrors.length
      ? accountErrors.map((a) => `${a.account_id}: ${a.message}`).join(" | ")
      : null,
  };
}

async function markAccountFetchError(pg: PgClient, accountId: string, message: string) {
  try {
    const ads = await pgSelect<{ entity_id: string; account_id: string; parent_id: string | null; name: string | null; status: string | null; agency_code: string | null }[]>(
      pg,
      `/ad_entities?select=entity_id,account_id,parent_id,name,status,agency_code&level=eq.ad&account_id=eq.${encodeURIComponent(accountId)}&limit=2000`,
    );
    const rows = (ads ?? []).map((a) => ({
      ...a,
      level: "ad",
      creative_fetch_status: "error",
      creative_fetch_error: message.slice(0, 300),
      creative_fetched_at: new Date().toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 200) {
      await pgUpsert(pg, "ad_entities", rows.slice(i, i + 200));
    }
  } catch {
    /* the account error is already reported by the caller */
  }
}

// ── Demographic breakdowns ───────────────────────────────────────────────────

type DemoInsight = {
  date_start: string;
  ad_id?: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  actions?: { action_type: string; value: string }[];
  age?: string;
  gender?: string;
};

export type DemoResult = {
  status: "success" | "partial" | "error";
  rowsWritten: number;
  since: string;
  until: string;
  accountErrors: { account_id: string; message: string }[];
  error: string | null;
};

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function leadsOf(actions: DemoInsight["actions"]) {
  const hit = actions?.find((a) => a.action_type === "lead");
  return hit ? Math.round(Number(hit.value) || 0) : 0;
}

/**
 * Trailing 28 days, clipped to the start of the previous month so the table can
 * never grow without bound, ad level only, and only ads that actually spent.
 */
export async function syncDemoBreakdowns(opts?: { since?: string | null; until?: string | null }): Promise<DemoResult> {
  const pg = getPg();
  const today = new Date();
  const prevMonthStart = isoDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)));
  const trailing = isoDate(new Date(today.getTime() - 28 * 24 * 60 * 60 * 1000));
  const since = opts?.since ?? (trailing < prevMonthStart ? prevMonthStart : trailing);
  const until = opts?.until ?? isoDate(today);

  const base: DemoResult = {
    status: "error",
    rowsWritten: 0,
    since,
    until,
    accountErrors: [],
    error: null,
  };
  if (!pg) return { ...base, error: "Lovable Cloud backend is not configured for this project yet." };
  const token = process.env["META_ACCESS_TOKEN"];
  if (!token) return { ...base, error: "META_ACCESS_TOKEN is not set." };

  const accounts = await pgSelect<AccountRow[]>(
    pg,
    "/ad_accounts?select=account_id,name,agency_code&is_active=eq.true",
  );

  let rowsWritten = 0;
  let ok = 0;
  const accountErrors: DemoResult["accountErrors"] = [];

  for (const account of accounts ?? []) {
    let accountOk = false;
    for (const breakdown of ["age", "gender"] as const) {
      try {
        const rows = await withBackoff(() =>
          graphGet<{ data: DemoInsight[] }>(
            `/act_${account.account_id}/insights`,
            {
              fields: "spend,impressions,inline_link_clicks,actions,ad_id",
              level: "ad",
              breakdowns: breakdown,
              time_increment: "1",
              time_range: JSON.stringify({ since, until }),
              limit: "500",
            },
            token,
          ),
        );
        const payload = (rows.data ?? [])
          .filter((r) => r.ad_id && Number(r.spend ?? 0) > 0)
          .map((r) => ({
            date: r.date_start,
            account_id: account.account_id,
            entity_id: r.ad_id,
            age_bucket: breakdown === "age" ? (r.age ?? "(unknown)") : "(unknown)",
            gender: breakdown === "gender" ? (r.gender ?? "(unknown)") : "(unknown)",
            spend: Number(r.spend ?? 0),
            impressions: Number(r.impressions ?? 0),
            link_clicks: Number(r.inline_link_clicks ?? 0),
            leads: leadsOf(r.actions),
          }));
        for (let i = 0; i < payload.length; i += 500) {
          rowsWritten += await pgRpc<number>(pg, "upsert_demo_metrics", {
            p_rows: payload.slice(i, i + 500),
          });
        }
        accountOk = true;
      } catch (e) {
        accountErrors.push({
          account_id: account.account_id,
          message: `${breakdown}: ${safeMessage(e)}`,
        });
      }
    }
    if (accountOk) ok += 1;
  }

  return {
    status: accountErrors.length === 0 ? "success" : ok > 0 ? "partial" : "error",
    rowsWritten,
    since,
    until,
    accountErrors,
    error: accountErrors.length
      ? accountErrors.map((a) => `${a.account_id}: ${a.message}`).join(" | ")
      : null,
  };
}

// ── Retrying the ads whose creative never arrived ────────────────────────────

export type CreativeRetryResult = {
  attempted: number;
  recovered: number;
  withThumbnail: number;
  withWatchLink: number;
  stillFailing: number;
  reasons: { message: string; ads: number }[];
};

/**
 * The whole-account creative call is rate-limited on the busiest accounts, and
 * when it fails every ad in that account is marked failed at once. That is a
 * fetch problem, not a missing creative — so ask Meta for those ads one at a
 * time, slowly, and keep the real reason for any that still will not come.
 */
export async function retryFailedCreatives(opts: { days?: number } = {}): Promise<CreativeRetryResult> {
  const pg = getPg();
  const out: CreativeRetryResult = {
    attempted: 0,
    recovered: 0,
    withThumbnail: 0,
    withWatchLink: 0,
    stillFailing: 0,
    reasons: [],
  };
  if (!pg) throw new Error("backend not configured");
  const token = process.env["META_ACCESS_TOKEN"];
  if (!token) throw new Error("META_ACCESS_TOKEN is not set.");

  const days = opts.days ?? 30;
  const targets = await pgRpc<{ entity_id: string; account_id: string | null }[]>(
    pg,
    "creative_retry_targets",
    { p_days: days },
  );

  const failures = new Map<string, number>();

  for (const t of targets ?? []) {
    out.attempted += 1;
    try {
      const ad = await withBackoff(
        () =>
          graphGet<MetaAdRow>(
            `/${t.entity_id}`,
            { fields: `id,name,status,adset_id,${CREATIVE_FIELDS}` },
            token,
          ),
        2,
      );
      const body = ad.creative?.body?.trim() || null;
      const title = ad.creative?.title?.trim() || null;
      const thumb = ad.creative?.thumbnail_url ?? null;
      const link = watchLink(ad.creative);
      const hasAny = Boolean(body || title || thumb);
      await pgUpsert(pg, "ad_entities", [
        {
          entity_id: t.entity_id,
          level: "ad",
          account_id: t.account_id,
          name: ad.name ?? null,
          status: ad.status ?? null,
          creative_body: body,
          creative_title: title,
          thumbnail_url: thumb,
          permalink_url: link,
          creative_object_type: ad.creative?.object_type ?? null,
          creative_fetch_status: hasAny ? "ok" : "empty",
          creative_fetch_error: hasAny ? null : "Meta returned no creative for this ad.",
          creative_fetched_at: new Date().toISOString(),
        },
      ]);
      if (hasAny) out.recovered += 1;
      else {
        out.stillFailing += 1;
        failures.set(
          "Meta returned no creative for this ad",
          (failures.get("Meta returned no creative for this ad") ?? 0) + 1,
        );
      }
      if (thumb) out.withThumbnail += 1;
      if (link) out.withWatchLink += 1;
    } catch (e) {
      out.stillFailing += 1;
      const msg = safeMessage(e).slice(0, 160);
      failures.set(msg, (failures.get(msg) ?? 0) + 1);
      await pgUpsert(pg, "ad_entities", [
        {
          entity_id: t.entity_id,
          level: "ad",
          account_id: t.account_id,
          creative_fetch_status: "error",
          creative_fetch_error: msg,
          creative_fetched_at: new Date().toISOString(),
        },
      ]).catch(() => undefined);
    }
    await sleep(250);
  }

  out.reasons = [...failures.entries()]
    .map(([message, ads]) => ({ message, ads }))
    .sort((a, b) => b.ads - a.ads);
  return out;
}
