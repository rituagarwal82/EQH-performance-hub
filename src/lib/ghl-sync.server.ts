/**
 * GoHighLevel → `leads` ingestion.
 *
 * Poll only. This credential has no webhook-management API (verified: /hooks
 * and /webhooks 404, workflows scope 401), so the feed is a paginated
 * `POST /contacts/search` over a `dateAdded` range, sorted ascending, walked
 * with `searchAfter`.
 *
 * Rules encoded here:
 *  1. Everything fetched is stored. `is_registered` (tag `registered` present
 *     OR webinar_date set) is what gates the funnel — the location also holds
 *     support contacts, customers and imports.
 *  2. The identity join key is the lowercased, trimmed email. Contacts without
 *     one are stored and counted, never dropped and never guessed.
 *  3. The custom field `accesst` holds a Meta access token. It is stripped from
 *     every payload before anything is written — it must never reach our DB.
 *  4. Numeric Meta IDs are stored as NULL when absent or templated ('{{ad.id}}').
 *  5. Idempotent: upsert on the GHL contact id.
 */

import { getPg, pgInsert, pgRpc, pgUpdate, type PgClient } from "./pg.server";
import { analyzeAfterWrite, refreshLeadAttribution } from "./load-guard.server";
import { lastRawError, safeMessage } from "./safe-error";

const GHL_API = "https://services.leadconnectorhq.com";

/** Cloudflare in front of the GHL API refuses default fetch agents. */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Custom field that carries a Meta access token — never stored. */
const FORBIDDEN_FIELD_KEY = "accesst";

/** Field keys we map. Resolved to ids at runtime from the location's schema. */
const FIELD_KEYS = [
  "date_of_joining",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "utm_placement",
  "campaign_id",
  "adset_id",
  "ad_id",
  "fbclid",
  "fbc",
  "fbp",
  "source_platform",
  "webinar_date",
  "webinar_time",
  "webinar_tag",
] as const;

type FieldKey = (typeof FIELD_KEYS)[number];

export type GhlSyncResult = {
  status: "success" | "partial" | "error";
  since: string;
  until: string;
  contactsFetched: number;
  rowsWritten: number;
  registered: number;
  withEmail: number;
  withoutEmail: number;
  withAdId: number;
  pages: number;
  earliest: string | null;
  latest: string | null;
  error: string | null;
  warnings: string[];
};

function credentials() {
  const key = process.env["GHL_API_KEY"];
  const location = process.env["GHL_LOCATION_ID"];
  if (!key || !location) {
    throw new Error(
      "The lead source is not connected: GHL_API_KEY and GHL_LOCATION_ID are missing from the project secrets.",
    );
  }
  return { key, location };
}

function headers(key: string) {
  return {
    Authorization: `Bearer ${key}`,
    Version: "2021-07-28",
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": UA,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ~5 req/s with backoff on 429 — the location burst limit is 100 per 10s. */
export async function ghl(path: string, key: string, init?: RequestInit): Promise<unknown> {
  let delay = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${GHL_API}${path}`, { ...init, headers: headers(key) });
    if (res.status === 429 || res.status >= 500) {
      await sleep(delay);
      delay *= 2;
      continue;
    }
    const text = await res.text();
    // GHL answers a timed-out search with 401 and the body "Command timed out".
    // That is their gateway giving up, not a bad key: retrying works, whereas
    // treating it as an auth failure kills a whole backfill window.
    if (res.status === 401 && /timed\s*out/i.test(text)) {
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      throw new Error(`GHL ${res.status} on ${path}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`GHL did not answer ${path} after 5 attempts (rate limit or gateway timeout)`);
}

type CustomFieldDef = { id?: string; fieldKey?: string };

/** fieldKey looks like `contact.utm_source`; we index by the bare name. */
export async function loadFieldMap(key: string, location: string) {
  const data = (await ghl(`/locations/${location}/customFields`, key)) as {
    customFields?: CustomFieldDef[];
  };
  const byId = new Map<string, string>();
  const idFor = new Map<string, string>();
  for (const f of data.customFields ?? []) {
    if (!f.id || !f.fieldKey) continue;
    const bare = f.fieldKey.replace(/^contact\./, "");
    byId.set(f.id, bare);
    if (!idFor.has(bare)) idFor.set(bare, f.id);
  }
  return { byId, idFor };
}

function cleanValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // One known row carries the literal ad template placeholder.
  if (s.includes("{{")) return null;
  return s;
}

/** `dd/MM/yyyy hh:mm:ss AM/PM` in IST → ISO UTC. */
export function parseJoiningDate(raw: unknown): string | null {
  const s = cleanValue(raw);
  if (!s) return null;
  const m = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM|am|pm)?$/,
  );
  if (m) {
    const [, d, mo, y, hh, mm, ss, ap] = m;
    let hour = Number(hh);
    const suffix = ap?.toUpperCase();
    if (suffix === "PM" && hour < 12) hour += 12;
    if (suffix === "AM" && hour === 12) hour = 0;
    const utcMs =
      Date.UTC(Number(y), Number(mo) - 1, Number(d), hour, Number(mm), Number(ss)) -
      5.5 * 3600 * 1000;
    const dt = new Date(utcMs);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

type Contact = Record<string, unknown> & {
  id?: string;
  email?: string | null;
  phone?: string | null;
  tags?: string[];
  dateAdded?: string;
  customFields?: { id?: string; value?: unknown }[];
  searchAfter?: unknown[];
};

export type LeadRow = Record<string, unknown>;

export function mapContact(
  contact: Contact,
  byId: Map<string, string>,
  idFor: Map<string, string>,
): LeadRow | null {
  const id = contact.id;
  if (!id) return null;

  const fields = new Map<string, unknown>();
  const safeCustomFields: { id: string; value: unknown }[] = [];
  for (const f of contact.customFields ?? []) {
    if (!f.id) continue;
    const name = byId.get(f.id);
    // The Meta access token never enters our database, raw payload included.
    if (name === FORBIDDEN_FIELD_KEY) continue;
    if (name) fields.set(name, f.value);
    safeCustomFields.push({ id: f.id, value: f.value });
  }
  const forbiddenId = idFor.get(FORBIDDEN_FIELD_KEY);
  const field = (k: FieldKey) => cleanValue(fields.get(k));
  // Fields the agency is still adding (page URL via Pabbly, gclid). Picked up
  // the moment they appear, whatever they end up being called, matched
  // case- and separator-insensitively.
  const looseField = (names: string[]): string | null => {
    for (const [name, value] of fields) {
      const k = name.toLowerCase().replace(/[\s-]/g, "_");
      if (names.includes(k)) {
        const v = cleanValue(value);
        if (v) return v;
      }
    }
    return null;
  };
  const pageField = () => looseField(["landing_page", "page_url", "landingpage", "pageurl"]);
  const gclidField = () => looseField(["gclid", "gclid_", "google_click_id", "gclid_id"]);

  const emailRaw = cleanValue(contact.email);
  const emailKey = emailRaw ? emailRaw.toLowerCase() : null;
  const tags = (contact.tags ?? []).map((t) => String(t));
  const webinarDate = field("webinar_date");
  const hasRegisteredTag = tags.some((t) => t.toLowerCase() === "registered");
  // Historical CSV imports carry the literal placeholder text `source` in
  // utm_source. Confirmed by the agency: not a live page bug. The marker is
  // normalised away and the row flagged; we never guess beyond this marker.
  const rawUtmSource = field("utm_source");
  const isImport = (rawUtmSource ?? "").trim().toLowerCase() === "source";
  const utmSource = isImport ? null : rawUtmSource;
  // An import-origin lead only counts as a registration when it independently
  // carries the registered tag AND webinar fields.
  const isRegistered =
    (hasRegisteredTag || Boolean(webinarDate)) &&
    (!isImport || (hasRegisteredTag && Boolean(webinarDate)));

  const raw: Record<string, unknown> = { ...contact, customFields: safeCustomFields };
  delete raw["searchAfter"];
  if (forbiddenId) delete raw[forbiddenId];

  const capturedAt = contact.dateAdded ? new Date(contact.dateAdded).toISOString() : null;
  const registeredAt = parseJoiningDate(fields.get("date_of_joining")) ?? capturedAt;

  const fullName = [cleanValue(contact["firstName"]), cleanValue(contact["lastName"])]
    .filter(Boolean)
    .join(" ");
  const name = cleanValue(contact["contactName"]) ?? (fullName === "" ? null : fullName);

  return {
    lead_id: id,
    source_system: "ghl",
    email_raw: emailRaw,
    email_key: emailKey,
    phone: cleanValue(contact.phone),
    name,
    captured_at: capturedAt,
    registered_at: registeredAt,
    utm_source: utmSource,
    is_import: isImport,
    utm_medium: field("utm_medium"),
    utm_campaign: field("utm_campaign"),
    utm_content: field("utm_content"),
    utm_term: field("utm_term"),
    utm_placement: field("utm_placement"),
    campaign_id: field("campaign_id"),
    adset_id: field("adset_id"),
    ad_id: field("ad_id"),
    fbclid: field("fbclid"),
    // Populated automatically once the agency creates the gclid field.
    gclid: gclidField(),

    fbc: field("fbc"),
    fbp: field("fbp"),
    // Populated automatically once a page/URL field appears on the contact.
    landing_page: pageField(),
    source_platform: field("source_platform"),
    platform: field("source_platform"),
    is_registered: isRegistered,
    tags,
    webinar_date: webinarDate,
    webinar_time: field("webinar_time"),
    webinar_tag: field("webinar_tag"),
    raw,
  };
}

export async function writeRows(pg: PgClient, rows: LeadRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const n = await pgRpc<number>(pg, "upsert_leads", { p_rows: chunk });
    written += Number(n) || 0;
  }
  return written;
}

export type GhlSyncOptions = {
  /** ISO date (yyyy-mm-dd). Defaults to the trailing 3-day rolling window. */
  since?: string | null;
  until?: string | null;
  /** Backfill depth in days when `since` is not given. */
  days?: number | null;
  source?: string;
  /** Safety valve for one invocation. */
  maxPages?: number;
};

export async function runGhlLeadSync(opts: GhlSyncOptions = {}): Promise<GhlSyncResult> {
  const now = new Date();
  const days = opts.days ?? 3;
  const untilIso = opts.until
    ? new Date(`${opts.until}T23:59:59.999Z`).toISOString()
    : now.toISOString();
  const sinceIso = opts.since
    ? new Date(`${opts.since}T00:00:00.000Z`).toISOString()
    : new Date(now.getTime() - days * 86400000).toISOString();

  const base: GhlSyncResult = {
    status: "error",
    since: sinceIso,
    until: untilIso,
    contactsFetched: 0,
    rowsWritten: 0,
    registered: 0,
    withEmail: 0,
    withoutEmail: 0,
    withAdId: 0,
    pages: 0,
    earliest: null,
    latest: null,
    error: null,
    warnings: [],
  };

  const pg = getPg();
  if (!pg)
    return { ...base, error: "Lovable Cloud backend is not configured for this project yet." };

  const run = await pgInsert<{ id: string }[]>(pg, "sync_runs", {
    source: opts.source ?? "ghl-leads",
    status: "running",
  });
  const runId = run?.[0]?.id;
  const finish = async (result: GhlSyncResult) => {
    // Planner statistics: a job never reports success on data the planner
    // still thinks is not there (7 Sep outage rule).
    if (result.rowsWritten > 0) {
      await analyzeAfterWrite(pg, ["leads"]);
      await refreshLeadAttribution(pg);
    }
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

  let key: string;
  let location: string;
  try {
    ({ key, location } = credentials());
  } catch (e) {
    return finish({ ...base, error: safeMessage(e) });
  }

  try {
    const { byId, idFor } = await loadFieldMap(key, location);
    const maxPages = opts.maxPages ?? 400;
    let searchAfter: unknown[] | null = null;
    let pages = 0;

    while (pages < maxPages) {
      const body: Record<string, unknown> = {
        locationId: location,
        pageLimit: 100,
        sort: [{ field: "dateAdded", direction: "asc" }],
        filters: [
          {
            field: "dateAdded",
            operator: "range",
            value: { gte: sinceIso, lte: untilIso },
          },
        ],
      };
      if (searchAfter) body["searchAfter"] = searchAfter;

      const page = (await ghl("/contacts/search", key, {
        method: "POST",
        body: JSON.stringify(body),
      })) as { contacts?: Contact[]; total?: number };

      const contacts = page.contacts ?? [];
      pages += 1;
      if (contacts.length === 0) break;

      const rows: LeadRow[] = [];
      for (const c of contacts) {
        const mapped = mapContact(c, byId, idFor);
        if (!mapped) continue;
        rows.push(mapped);
        base.contactsFetched += 1;
        if (mapped["is_registered"]) base.registered += 1;
        if (mapped["email_key"]) base.withEmail += 1;
        else base.withoutEmail += 1;
        if (mapped["ad_id"]) base.withAdId += 1;
        const captured = mapped["captured_at"] as string | null;
        if (captured) {
          if (!base.earliest || captured < base.earliest) base.earliest = captured;
          if (!base.latest || captured > base.latest) base.latest = captured;
        }
      }

      base.rowsWritten += await writeRows(pg, rows);
      base.pages = pages;

      const last = contacts[contacts.length - 1];
      const next = last?.searchAfter;
      if (!next || !Array.isArray(next)) break;
      searchAfter = next;
      // ~5 req/s.
      await sleep(200);
    }

    if (pages >= (opts.maxPages ?? 400)) {
      base.warnings.push(
        "Page ceiling reached for this run — the remaining contacts in the window are picked up by the next run.",
      );
    }

    // Resolve the ad reference for the rows just written: ad id where present,
    // otherwise a unique ad-name match on utm_content.
    //
    // This is NOT optional work. When it fails, leads land with no ad reference
    // and every team's paid-performance ratio silently drifts — so a failure
    // here fails the whole run, shows on Feed Health, and raises a review item.
    try {
      await pgRpc(pg, "resolve_lead_ad_refs", { p_only_new: true });
      // A lead's team is decided by who owns the ad account its ad sits in —
      // the same rule the spend side uses. That can only be applied once the ad
      // reference above exists, so it runs here, immediately after, every time.
      // Skipping it would leave leads on the old link-code rule while spend
      // moved to ownership: one team's cash against another team's cost.
      // Bounded to the recent window (plus anything just re-matched) so this
      // step cannot run long enough to time the request out, as it did five
      // times in the 48h to 19 Sep. A full pass is a deliberate, separate run.
      // Bounded AND patient: a busy minute at the database (the 504s of 17–19
      // Sep) is waited out three times over, and every wait is logged so a
      // step that only survives by retrying is still visible on the screens.
      const { withLoggedRetry } = await import("./retry-log.server");
      await withLoggedRetry("leads", "refresh_lead_agency", () =>
        pgRpc(pg, "refresh_lead_agency", { p_days: 45 }),
      );
      // Coverage per team moves with every matching pass, so re-derive it here
      // rather than letting the stored figure drift.
      await pgRpc(pg, "refresh_agency_ratio_flags", { p_days: 30 });

      // A lead with no source decision belongs to nobody: its sale reads
      // "No lead record" and its team gets no credit. Until 11 Sep this only
      // happened on a full rebuild, so four days of leads had no source at
      // all. It now runs on every sync, for the leads just written.
      const resolved =
        (await pgRpc<number>(pg, "resolve_unified_source_incremental", {
          p_window: "12 hours",
        })) ?? 0;
      if (resolved > 0) {
        const { refreshSourcePrecompute } = await import("./source-precompute.server");
        await refreshSourcePrecompute();
      }



    } catch (e) {
      const reason = safeMessage(e);
      try {
        const { raiseReviewItem } = await import("./review.server");
        await raiseReviewItem(pg, {
          kind: "job_failure",
          refId: "resolve_lead_ad_refs",
          title: "New leads have not been matched to their ads",
          detail:
            "The lead sync stored its leads but could not match them to ads, so team-level paid figures are missing recent leads until this succeeds.",
          evidence: { step: "resolve_lead_ad_refs / refresh_agency_ratio_flags", reason },
        });
      } catch {
        // A failure to file the note must not hide the failure itself.
      }
      return finish({ ...base, error: `Ad matching failed: ${reason}` });
    }


    return finish({ ...base, status: base.warnings.length ? "partial" : "success" });
  } catch (e) {
    return finish({ ...base, error: safeMessage(e) });
  }
}
