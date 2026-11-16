/**
 * Zoom → zoom_sessions / zoom_participants sync.
 *
 * Credentials come from Cloud secrets at call time and are never stored in code:
 *   ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, optional ZOOM_USER_ID
 * (Server-to-Server OAuth app.)
 *
 * Non-negotiable rules implemented here:
 *  1. The topic filter is read from app_settings.zoom_l1_topic_match at runtime.
 *     Non-matching sessions are recorded in zoom_ignored_sessions and no
 *     participant detail is fetched for them (quota discipline).
 *  2. Raw join/leave segments are stored as-is; impossible rows are flagged
 *     is_valid = false with a reason and excluded from the zoom_attendance view.
 *  3. business_date is a 06:00–05:59 IST day, computed in Postgres.
 *  4. EVERY SOURCE IS INDEPENDENT. A missing webinar plan, a refused scope or a
 *     single bad host degrades that source only — the run continues and the
 *     precise reason is persisted so the owner sees it on /webinars.
 */

import { getPg, pgInsert, pgRpc, pgSelect, pgUpdate, pgUpsert, type PgClient } from "./pg.server";
import { analyzeAfterWrite } from "./load-guard.server";
import {
  DEFAULT_TOPIC_RULES,
  classifyTopic,
  eventKeyFor,
  type TopicRules,
} from "./zoom-topic";
import { lastRawError, safeMessage } from "./safe-error";
import {
  backfillSessionHosts,
  isSkipped,
  markSkipped,
  readHostRegistry,
  resolveHostEmails,
  writeHostRegistry,
  type HostRegistry,
} from "./zoom-hosts.server";

const ZOOM_API = "https://api.zoom.us/v2";

export type ZoomSourceStatus = {
  /** "webinars" | "meetings" | "users" */
  source: string;
  label: string;
  available: boolean;
  /** Plain-language reason when unavailable, or an informational note. */
  note: string | null;
  /** Exact Zoom scope the owner must add, when that is the blocker. */
  missingScopes: string[];
  sessionsReturned: number;
  matched: number;
  ignored: number;
  hosts: string[];
};

export type ZoomSyncResult = {
  status: "success" | "partial" | "error";
  since: string;
  until: string;
  sessionsMatched: number;
  sessionsIgnored: number;
  participantRowsWritten: number;
  invalidRows: number;
  invalidPct: number | null;
  earliestSession: string | null;
  latestSession: string | null;
  topicMatch: string | null;
  rowsWritten: number;
  error: string | null;
  warnings: string[];
  sources: ZoomSourceStatus[];
};

type RawSession = {
  uuid: string;
  id: string;
  topic: string;
  start_time: string;
  end_time?: string | null;
  duration?: number | null;
  host_email?: string | null;
  host_id?: string | null;
  type: "webinar" | "meeting";
};

/** The login the listing was made for — Zoom often omits the host on the row itself. */
export type SweepHost = { id: string; email: string | null };

/** "me" is a credential alias, never a real host id. */
function hostIdOf(host: SweepHost) {
  return host.id && host.id !== "me" ? host.id : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Zoom UUIDs can contain "/" and "=". When a UUID begins with "/" or contains
 * "//" it MUST be double URL-encoded in an API path, otherwise Zoom 404s.
 */
export function encodeZoomUuid(uuid: string) {
  const once = encodeURIComponent(uuid);
  if (uuid.startsWith("/") || uuid.includes("//")) return encodeURIComponent(once);
  return once;
}

export class ZoomApiError extends Error {
  status: number;
  code: number | null;
  zoomMessage: string;
  path: string;
  constructor(status: number, path: string, raw: string) {
    let code: number | null = null;
    let zoomMessage = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { code?: number; message?: string };
      if (typeof parsed.code === "number") code = parsed.code;
      if (typeof parsed.message === "string") zoomMessage = parsed.message;
    } catch {
      /* keep the raw text */
    }
    super(`Zoom ${status} on ${path}: ${zoomMessage}`);
    this.name = "ZoomApiError";
    this.status = status;
    this.code = code;
    this.zoomMessage = zoomMessage;
    this.path = path;
  }
}

/** Zoom answers "no webinar licence" with HTTP 400 and body code 200. */
function isWebinarPlanMissing(e: unknown) {
  return e instanceof ZoomApiError && /webinar plan is missing/i.test(e.zoomMessage);
}

export function extractMissingScopes(message: string) {
  return Array.from(
    new Set(
      [...message.matchAll(/scopes?:\s*\[([^\]]+)\]/gi)]
        .flatMap((m) => (m[1] ?? "").split(","))
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

function scopesOf(e: unknown) {
  return e instanceof Error ? extractMissingScopes(e.message) : [];
}

async function getToken() {
  const accountId = process.env["ZOOM_ACCOUNT_ID"];
  const clientId = process.env["ZOOM_CLIENT_ID"];
  const clientSecret = process.env["ZOOM_CLIENT_SECRET"];
  const missing = [
    !accountId && "ZOOM_ACCOUNT_ID",
    !clientId && "ZOOM_CLIENT_ID",
    !clientSecret && "ZOOM_CLIENT_SECRET",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Missing Cloud secret(s): ${missing.join(", ")}. Add the Zoom Server-to-Server OAuth credentials, then run the sync again.`,
    );
  }
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId!)}`,
    { method: "POST", headers: { Authorization: `Basic ${basic}` } },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Zoom OAuth failed (${res.status}): ${text.slice(0, 400)}`);
  const body = JSON.parse(text) as { access_token?: string };
  if (!body.access_token) throw new Error(`Zoom OAuth returned no access_token: ${text.slice(0, 400)}`);
  return body.access_token;
}

type ZoomGetOpts = { tolerate?: number[] };

/** GET with 429 back-off (honours Retry-After) and 4 retries. */
async function zoomGet<T>(path: string, token: string, opts: ZoomGetOpts = {}): Promise<T | null> {
  let attempt = 0;
  for (;;) {
    const res = await fetch(`${ZOOM_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
      if (attempt >= 4) throw new Error(`Zoom rate limit exhausted on ${path}`);
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
      attempt += 1;
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      if (opts.tolerate?.includes(res.status)) return null;
      throw new ZoomApiError(res.status, path, text);
    }
    return (text ? JSON.parse(text) : null) as T;
  }
}

/** Follows next_page_token, collecting one array field. */
async function zoomPaged<T>(
  path: string,
  token: string,
  field: string,
  opts: ZoomGetOpts = {},
): Promise<T[]> {
  const out: T[] = [];
  let pageToken = "";
  for (let guard = 0; guard < 200; guard += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${sep}page_size=300${pageToken ? `&next_page_token=${encodeURIComponent(pageToken)}` : ""}`;
    const body = await zoomGet<Record<string, unknown>>(url, token, opts);
    if (!body) return out;
    const rows = (body[field] as T[] | undefined) ?? [];
    out.push(...rows);
    pageToken = (body["next_page_token"] as string | undefined) ?? "";
    if (!pageToken) return out;
  }
  throw new Error(`Zoom pagination guard hit on ${path}`);
}

function monthChunks(since: string, until: string) {
  const chunks: { from: string; to: string }[] = [];
  let cursor = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  let guard = 0;
  while (cursor <= end && guard++ < 60) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const to = next > end ? end : new Date(next.getTime() - 86400000);
    chunks.push({ from: cursor.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
    cursor = new Date(next);
  }
  return chunks;
}

async function listPastMeetings(
  token: string,
  host: SweepHost,
  since: string,
  until: string,
) {
  const userId = host.id;
  const out: RawSession[] = [];
  // Zoom refuses meeting reports older than six months; clamp instead of failing.
  const floor = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const effectiveSince = since < floor ? floor : since;
  for (const chunk of monthChunks(effectiveSince, until)) {

    const rows = await zoomPaged<{
      uuid: string;
      id: number | string;
      topic: string;
      start_time: string;
      end_time?: string;
      duration?: number;
      user_email?: string;
    }>(
      `/report/users/${encodeURIComponent(userId)}/meetings?type=past&from=${chunk.from}&to=${chunk.to}`,
      token,
      "meetings",
    );
    for (const r of rows) {
      out.push({
        uuid: r.uuid,
        id: String(r.id),
        topic: r.topic ?? "",
        start_time: r.start_time,
        end_time: r.end_time ?? null,
        duration: r.duration ?? null,
        // The listing row often omits the host; the login we are sweeping IS
        // the host, so the field can never go blank again.
        host_email: r.user_email ?? host.email ?? null,
        host_id: hostIdOf(host),
        type: "meeting",
      });
    }
  }
  return out;
}

type RawWebinarRow = {
  uuid: string;
  id: number | string;
  topic: string;
  start_time: string;
  end_time?: string;
  duration?: number;
  host_email?: string;
  user_email?: string;
};

function mapWebinar(r: RawWebinarRow, host: SweepHost): RawSession {
  return {
    uuid: r.uuid,
    id: String(r.id),
    topic: r.topic ?? "",
    start_time: r.start_time,
    end_time: r.end_time ?? null,
    duration: r.duration ?? null,
    host_email: r.host_email ?? r.user_email ?? host.email ?? null,
    host_id: hostIdOf(host),
    type: "webinar",
  };
}

/**
 * Past webinars for one host.
 *
 * /users/{id}/webinars?type=past returns webinar DEFINITIONS (Simulive rows
 * are type 9), whose uuid is NOT the uuid of an occurrence — the participant
 * report 404s "Meeting does not exist" on it. The real occurrences come from
 * /past_webinars/{webinarId}/instances, and those instance uuids are what the
 * report accepts. Instances are only expanded for topic-matching definitions,
 * so a non-L1 webinar costs one listing row and no extra call.
 */
async function listPastWebinars(
  token: string,
  host: SweepHost,
  since: string,
  until: string,
  needle: string,
) {
  const fromMs = Date.parse(`${since}T00:00:00Z`);
  const toMs = Date.parse(`${until}T23:59:59Z`);
  const uid = encodeURIComponent(host.id); // email → @ becomes %40
  const defs = await zoomPaged<RawWebinarRow>(`/users/${uid}/webinars?type=past`, token, "webinars");

  const out: RawSession[] = [];
  for (const def of defs) {
    const topic = def.topic ?? "";
    if (!topic.toLowerCase().includes(needle)) {
      // Non-matching: keep the definition row so it is counted and logged as ignored.
      out.push(mapWebinar(def, host));
      continue;
    }
    let instances: { uuid: string; start_time: string }[] = [];
    try {
      instances = await zoomPaged<{ uuid: string; start_time: string }>(
        `/past_webinars/${encodeURIComponent(String(def.id))}/instances`,
        token,
        "webinars",
        { tolerate: [404] },
      );
    } catch {
      instances = [];
    }
    for (const inst of instances) {
      const started = Date.parse(inst.start_time ?? def.start_time);
      if (!Number.isFinite(started) || started < fromMs || started > toMs) continue;
      out.push({
        uuid: inst.uuid,
        id: String(def.id),
        topic,
        start_time: inst.start_time ?? def.start_time,
        end_time: null,
        duration: def.duration ?? null,
        // Instance rows carry no host at all — attribute them to the login the
        // listing was made for rather than leaving the field blank.
        host_email: def.host_email ?? def.user_email ?? host.email ?? null,
        host_id: hostIdOf(host),
        type: "webinar",
      });
    }
  }
  return out;
}



type ZoomUser = { id: string; email?: string; type?: number; status?: string };

/**
 * Enumerate the hosts to pull. The account's active-user list WINS: a webinar
 * hosted from any login on the account must be captured, and the topic filter
 * discards non-L1 sessions for one cheap listing call per host. ZOOM_USER_ID is
 * only a fallback for when that list call fails, and "me" the last resort.
 */
async function resolveHosts(
  token: string,
  registry: HostRegistry,
): Promise<{
  hosts: { id: string; email: string | null }[];
  skipped: { who: string; reason: string }[];
  status: ZoomSourceStatus;
}> {
  const pinned = process.env["ZOOM_USER_ID"]?.trim();

  try {
    const users = await zoomPaged<ZoomUser>("/users?status=active", token, "users");
    const all = users
      .filter((u) => u.id)
      .map((u) => ({ id: u.id, email: u.email ?? null }));
    if (all.length === 0) throw new Error("Zoom returned an empty active-user list");
    // A login already known to have no Webinar licence is left alone until its
    // weekly re-probe falls due: querying it every 6 hours only manufactures alarms.
    const skipped: { who: string; reason: string }[] = [];
    const hosts = all.filter((h) => {
      const rec = isSkipped(registry, [h.email, h.id]);
      if (!rec) return true;
      skipped.push({ who: h.email ?? h.id, reason: rec.reason });
      return false;
    });
    return {
      hosts,
      skipped,
      status: {
        source: "users",
        label: "Zoom hosts",
        available: true,
        note: `${hosts.length} host${hosts.length === 1 ? "" : "s"} swept from the account user list${
          skipped.length
            ? ` · ${skipped.length} skipped: ${skipped.map((s) => `${s.who} (${s.reason})`).join(", ")} — re-checked weekly`
            : ""
        }.`,
        missingScopes: [],
        sessionsReturned: hosts.length,
        matched: 0,
        ignored: 0,
        hosts: hosts.map((h) => h.email ?? h.id),
      },
    };
  } catch (e) {
    const scopes = scopesOf(e);
    const detail = e instanceof Error ? e.message : String(e);
    const reason = scopes.length
      ? `Add the scope ${scopes.join(", ")} at marketplace.zoom.us → Manage → your app → Scopes.`
      : `Zoom said: ${detail}`;
    if (pinned) {
      return {
        hosts: [{ id: pinned, email: null }],
        skipped: [],
        status: {
          source: "users",
          label: "Zoom hosts",
          available: false,
          note: `Cannot list the account's hosts, so only the pinned ZOOM_USER_ID (${pinned}) was swept — a webinar hosted from another login would be missed. ${reason}`,
          missingScopes: scopes,
          sessionsReturned: 0,
          matched: 0,
          ignored: 0,
          hosts: [pinned],
        },
      };
    }
    return {
      hosts: [{ id: "me", email: null }],
      skipped: [],
      status: {
        source: "users",
        label: "Zoom hosts",
        available: false,
        note: `Cannot list the account's hosts, so only the credential owner ("me") was swept. ${reason}`,
        missingScopes: scopes,
        sessionsReturned: 0,
        matched: 0,
        ignored: 0,
        hosts: ["me"],
      },
    };
  }
}


type ParticipantRow = {
  id?: string;
  user_id?: string;
  participant_uuid?: string;
  name?: string;
  user_email?: string;
  join_time?: string;
  leave_time?: string;
  duration?: number;
};

export type ParticipantFetch = {
  rows: ParticipantRow[];
  status: "fetched" | "empty" | "failed" | "unavailable";
  note: string | null;
};

async function fetchParticipants(token: string, session: RawSession): Promise<ParticipantFetch> {
  const primary = session.type === "webinar" ? "webinars" : "meetings";
  const fallback = primary === "webinars" ? "meetings" : "webinars";
  const path = (kind: string) =>
    `/report/${kind}/${encodeZoomUuid(session.uuid)}/participants`;

  // A tolerated 404 means Zoom has no report for this occurrence at all
  // (retention window, or a definition that never ran) — that is 'unavailable',
  // which is a different fact from "the report came back with nobody in it".
  const attempt = async (kind: string) => {
    const seen = { notFound: false };
    const rows = await zoomPagedTracked<ParticipantRow>(path(kind), token, "participants", seen);
    return { rows, notFound: seen.notFound };
  };

  try {
    const first = await attempt(primary);
    if (first.notFound && first.rows.length === 0) {
      return {
        rows: [],
        status: "unavailable",
        note: `Zoom has no participant report for this ${primary === "webinars" ? "webinar" : "meeting"} occurrence (404). Reports are only retained for recent sessions.`,
      };
    }
    return {
      rows: first.rows,
      status: first.rows.length ? "fetched" : "empty",
      note: first.rows.length ? null : "Zoom returned the report with no participants.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Zoom's past-meetings listing also returns webinar occurrences (and vice
    // versa). The report endpoints refuse the wrong kind with
    // "Can not access webinar info" / "Can not access meeting info".
    if (/Can not access (webinar|meeting) info/i.test(message)) {
      try {
        const second = await attempt(fallback);
        if (second.notFound && second.rows.length === 0) {
          return { rows: [], status: "unavailable", note: `No participant report available (404 on both report kinds).` };
        }
        return {
          rows: second.rows,
          status: second.rows.length ? "fetched" : "empty",
          note: second.rows.length ? null : "Zoom returned the report with no participants.",
        };
      } catch (e2) {
        return { rows: [], status: "failed", note: e2 instanceof Error ? e2.message : String(e2) };
      }
    }
    return { rows: [], status: "failed", note: message };
  }
}

/** zoomPaged, but tells the caller whether a tolerated 404 was hit. */
async function zoomPagedTracked<T>(
  path: string,
  token: string,
  field: string,
  seen: { notFound: boolean },
): Promise<T[]> {
  const out: T[] = [];
  let pageToken = "";
  for (let guard = 0; guard < 200; guard += 1) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${sep}page_size=300${pageToken ? `&next_page_token=${encodeURIComponent(pageToken)}` : ""}`;
    let body: Record<string, unknown> | null;
    try {
      body = await zoomGet<Record<string, unknown>>(url, token);
    } catch (e) {
      if (e instanceof ZoomApiError && e.status === 404) {
        seen.notFound = true;
        return out;
      }
      throw e;
    }
    if (!body) return out;
    out.push(...(((body[field] as T[] | undefined) ?? []) as T[]));
    pageToken = (body["next_page_token"] as string | undefined) ?? "";
    if (!pageToken) return out;
  }
  throw new Error(`Zoom pagination guard hit on ${path}`);
}

async function fetchRegistrantCount(token: string, session: RawSession) {
  if (session.type !== "webinar") return null;
  try {
    const body = await zoomGet<{ total_records?: number }>(
      `/webinars/${encodeURIComponent(session.id)}/registrants?page_size=1`,
      token,
      { tolerate: [404] },
    );
    return typeof body?.total_records === "number" ? body.total_records : null;
  } catch {
    return null;
  }
}


function validate(
  segment: ParticipantRow,
  sessionStart: string,
): { is_valid: boolean; invalid_reason: string | null } {
  const join = segment.join_time ? Date.parse(segment.join_time) : NaN;
  const leave = segment.leave_time ? Date.parse(segment.leave_time) : NaN;
  const start = Date.parse(sessionStart);
  const duration = segment.duration ?? null;

  if (Number.isFinite(leave) && Number.isFinite(start) && leave < start) {
    return { is_valid: false, invalid_reason: "leave_time before session start_time" };
  }
  if (Number.isFinite(leave) && Number.isFinite(join) && leave < join) {
    return { is_valid: false, invalid_reason: "leave_time before join_time" };
  }
  if (duration !== null && duration < 0) {
    return { is_valid: false, invalid_reason: "negative duration_sec" };
  }
  return { is_valid: true, invalid_reason: null };
}

async function readTopicMatch(pg: PgClient) {
  const rows = await pgSelect<{ value: string | null }[]>(
    pg,
    "/app_settings?select=value&key=eq.zoom_l1_topic_match",
  );
  const value = rows?.[0]?.value?.trim();
  if (!value) {
    throw new Error(
      "app_settings.zoom_l1_topic_match is empty. Set the topic filter phrase before syncing — an empty filter would ingest every meeting on the account.",
    );
  }
  return value;
}

/**
 * Topic normalisation rules are owner-editable in app_settings.zoom_topic_rules.
 * A malformed or absent row falls back to the defaults rather than failing the
 * run — but the fallback is reported as a warning, never silently.
 */
export async function readTopicRules(pg: PgClient): Promise<{ rules: TopicRules; warning: string | null }> {
  try {
    const rows = await pgSelect<{ value: string | null }[]>(
      pg,
      "/app_settings?select=value&key=eq.zoom_topic_rules",
    );
    const raw = rows?.[0]?.value?.trim();
    if (!raw) {
      return { rules: DEFAULT_TOPIC_RULES, warning: "app_settings.zoom_topic_rules is not set — using built-in defaults." };
    }
    const parsed = JSON.parse(raw) as Partial<TopicRules>;
    return {
      rules: {
        replay_words: parsed.replay_words ?? DEFAULT_TOPIC_RULES.replay_words,
        test_words: parsed.test_words ?? DEFAULT_TOPIC_RULES.test_words,
        date_patterns: parsed.date_patterns ?? DEFAULT_TOPIC_RULES.date_patterns,
        replay_offset_days: parsed.replay_offset_days ?? DEFAULT_TOPIC_RULES.replay_offset_days,
      },
      warning: null,
    };
  } catch (e) {
    return {
      rules: DEFAULT_TOPIC_RULES,
      warning: `app_settings.zoom_topic_rules could not be read (${safeMessage(e)}) — using built-in defaults.`,
    };
  }
}

async function persistSourceStatus(pg: PgClient, sources: ZoomSourceStatus[]) {
  try {
    await pgUpsert(pg, "app_settings?on_conflict=key", {
      key: "zoom_source_status",
      value: JSON.stringify({ checked_at: new Date().toISOString(), sources }),
      description: "Per-source Zoom availability written by the last sync run. Machine-managed.",
      updated_at: new Date().toISOString(),
    });
  } catch {
    /* status reporting must never break the sync */
  }
}

export async function runZoomSync(opts: {
  since?: string | null;
  until?: string | null;
  source?: string;
}): Promise<ZoomSyncResult> {
  const pg = getPg();
  const today = new Date();
  const since = opts.since ?? new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const until = opts.until ?? today.toISOString().slice(0, 10);

  const base: ZoomSyncResult = {
    status: "error",
    since,
    until,
    sessionsMatched: 0,
    sessionsIgnored: 0,
    participantRowsWritten: 0,
    invalidRows: 0,
    invalidPct: null,
    earliestSession: null,
    latestSession: null,
    topicMatch: null,
    rowsWritten: 0,
    error: null,
    warnings: [],
    sources: [],
  };

  if (!pg) return { ...base, error: "Lovable Cloud backend is not configured for this project yet." };

  const run = await pgInsert<{ id: string }[]>(pg, "sync_runs", {
    source: opts.source ?? "zoom-manual",
    status: "running",
  });
  const runId = run?.[0]?.id;
  const finish = async (result: ZoomSyncResult) => {
    // Planner statistics: a job never reports success on data the planner
    // still thinks is not there (7 Sep outage rule).
    if (result.rowsWritten > 0) await analyzeAfterWrite(pg, ["zoom_sessions", "zoom_participants"]);
    await persistSourceStatus(pg, result.sources);
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

  let topicMatch: string;
  let token: string;
  try {
    topicMatch = await readTopicMatch(pg);
    token = await getToken();
  } catch (e) {
    return finish({ ...base, error: safeMessage(e) });
  }
  base.topicMatch = topicMatch;
  const needle = topicMatch.toLowerCase();

  const warnings: string[] = [];
  const { rules: topicRules, warning: rulesWarning } = await readTopicRules(pg);
  if (rulesWarning) warnings.push(rulesWarning);
  const registry = await readHostRegistry(pg);
  const { hosts, skipped, status: hostStatus } = await resolveHosts(token, registry);
  let registryChanged = false;
  if (!hostStatus.available && hostStatus.note) warnings.push(hostStatus.note);

  const webinarStatus: ZoomSourceStatus = {
    source: "webinars",
    label: "Zoom Webinars",
    available: false,
    note: null,
    missingScopes: [],
    sessionsReturned: 0,
    matched: 0,
    ignored: 0,
    hosts: [],
  };
  const meetingStatus: ZoomSourceStatus = {
    source: "meetings",
    label: "Zoom Meetings",
    available: false,
    note: null,
    missingScopes: [],
    sessionsReturned: 0,
    matched: 0,
    ignored: 0,
    hosts: [],
  };

  const sessions: RawSession[] = [];

  // ---- Source 1: past webinars, per host. Independent of everything else. ----
  const webinarNotes: string[] = [];
  // Informational, never an alarm: a login with no Webinar licence cannot
  // create a Webinar, so it cannot be hiding sessions from us.
  const licenceNotes: string[] = skipped.map((s) => `${s.who}: ${s.reason}`);
  for (const host of hosts) {
    const who = host.email ?? host.id;
    try {
      const rows = await listPastWebinars(token, host, since, until, needle);
      webinarStatus.available = true;
      webinarStatus.sessionsReturned += rows.length;
      webinarStatus.hosts.push(who);
      sessions.push(...rows);
    } catch (e) {
      if (isWebinarPlanMissing(e)) {
        licenceNotes.push(`${who}: no Webinar licence — skipped`);
        markSkipped(registry, who, "no Webinar licence — skipped");
        registryChanged = true;
        continue;
      }
      const scopes = scopesOf(e);
      if (scopes.length) webinarStatus.missingScopes.push(...scopes);
      webinarNotes.push(`${who}: ${safeMessage(e)}`);
    }
  }
  webinarStatus.missingScopes = Array.from(new Set(webinarStatus.missingScopes));
  if (registryChanged) await writeHostRegistry(pg, registry);
  const licenceLine = licenceNotes.length
    ? `${licenceNotes.length} login${licenceNotes.length === 1 ? "" : "s"} without a Webinar licence are not swept (${licenceNotes.join(" · ")}) — re-checked weekly, not an error.`
    : null;
  if (webinarNotes.length) {
    webinarStatus.note = webinarStatus.available
      ? `Partly unavailable — ${webinarNotes.join(" · ")}`
      : webinarStatus.missingScopes.length
        ? `Unavailable — your app is missing the scope ${webinarStatus.missingScopes.join(", ")}. Add it at marketplace.zoom.us → Manage → your app → Scopes. (${webinarNotes.join(" · ")})`
        : `Unavailable — ${webinarNotes.join(" · ")}. Sessions run as ordinary Zoom Meetings are still ingested below.`;
    warnings.push(`webinars: ${webinarNotes.join(" · ")}`);
  } else if (!webinarStatus.available) {
    webinarStatus.note = "Unavailable — no host could be queried.";
  } else if (licenceLine) {
    webinarStatus.note = licenceLine;
  }

  // ---- Source 2: past meetings, per host. Runs regardless of source 1. ----
  const meetingNotes: string[] = [];
  for (const host of hosts) {
    const who = host.email ?? host.id;
    try {
      const rows = await listPastMeetings(token, host, since, until);
      meetingStatus.available = true;
      meetingStatus.sessionsReturned += rows.length;
      meetingStatus.hosts.push(who);
      sessions.push(...rows);
    } catch (e) {
      const scopes = scopesOf(e);
      if (scopes.length) meetingStatus.missingScopes.push(...scopes);
      meetingNotes.push(`${who}: ${safeMessage(e)}`);
    }
  }
  meetingStatus.missingScopes = Array.from(new Set(meetingStatus.missingScopes));
  if (meetingNotes.length) {
    meetingStatus.note = meetingStatus.available
      ? `Partly unavailable — ${meetingNotes.join(" · ")}`
      : meetingStatus.missingScopes.length
        ? `Unavailable — your app is missing the scope ${meetingStatus.missingScopes.join(", ")}. Add it at marketplace.zoom.us → Manage → your app → Scopes.`
        : `Unavailable — ${meetingNotes.join(" · ")}`;
    warnings.push(`meetings: ${meetingNotes.join(" · ")}`);
  }

  const sourceStatuses = [webinarStatus, meetingStatus, hostStatus];

  if (!webinarStatus.available && !meetingStatus.available) {
    return finish({
      ...base,
      sources: sourceStatuses,
      warnings,
      error: `No Zoom source is available. ${[webinarStatus.note, meetingStatus.note, hostStatus.available ? null : hostStatus.note]
        .filter(Boolean)
        .join(" | ")}`,
    });
  }

  // Range filter (webinar listing is not date-bounded by the API).
  const fromMs = Date.parse(`${since}T00:00:00Z`);
  const toMs = Date.parse(`${until}T23:59:59Z`);
  const inRange = sessions.filter((s) => {
    const t = Date.parse(s.start_time);
    return Number.isFinite(t) && t >= fromMs && t <= toMs;
  });

  // De-duplicate by uuid (a session can appear in both listings / for two hosts).
  const byUuid = new Map<string, RawSession>();
  for (const s of inRange) if (s.uuid && !byUuid.has(s.uuid)) byUuid.set(s.uuid, s);

  // TOPIC FILTER FIRST — no participant detail for non-matching sessions.
  const matched: RawSession[] = [];
  const ignored: RawSession[] = [];
  for (const s of byUuid.values()) {
    const target = s.type === "webinar" ? webinarStatus : meetingStatus;
    if ((s.topic ?? "").toLowerCase().includes(needle)) {
      matched.push(s);
      target.matched += 1;
    } else {
      ignored.push(s);
      target.ignored += 1;
    }
  }

  if (ignored.length > 0) {
    try {
      await pgUpsert(
        pg,
        "zoom_ignored_sessions?on_conflict=session_uuid",
        ignored.map((s) => ({
          session_uuid: s.uuid,
          zoom_id: s.id,
          session_type: s.type,
          topic: s.topic,
          start_time: s.start_time,
          host_email: s.host_email,
          seen_at: new Date().toISOString(),
        })),
      );
    } catch (e) {
      warnings.push(`ignored-session log: ${safeMessage(e)}`);
    }
  }

  let participantRows = 0;
  let invalidRows = 0;
  let totalSegments = 0;
  let sessionsWritten = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  const participantErrors: string[] = [];

  for (const session of matched) {
    if (!earliest || session.start_time < earliest) earliest = session.start_time;
    if (!latest || session.start_time > latest) latest = session.start_time;

    // The session itself is a fact we already have. Persist it before touching
    // the participant report, so a refused participant endpoint degrades
    // attendance only — never hides the session.
    let attendees: number | null = null;
    let registrants: number | null = null;
    let rows: Array<Record<string, unknown> & { is_valid: boolean }> = [];

    const fetched = await fetchParticipants(token, session);
    if (fetched.status === "failed") {
      participantErrors.push(`session ${session.uuid} (${session.topic}): ${fetched.note}`);
    }
    registrants = await fetchRegistrantCount(token, session);

    rows = fetched.rows.map((seg) => {
      const check = validate(seg, session.start_time);
      return {
        session_uuid: session.uuid,
        participant_id:
          seg.id || seg.participant_uuid || seg.user_id || `${seg.user_email ?? seg.name ?? "unknown"}`,
        name: seg.name ?? null,
        email: seg.user_email ?? null,
        join_time: seg.join_time ?? null,
        leave_time: seg.leave_time ?? null,
        duration_sec: seg.duration ?? null,
        is_valid: check.is_valid,
        invalid_reason: check.invalid_reason,
      };
    });

    if (fetched.status === "fetched" || fetched.status === "empty") {
      const validRows = rows.filter((r) => r.is_valid);
      attendees = new Set(
        validRows.map((r) => (r["email"] ? String(r["email"]).toLowerCase() : String(r["participant_id"]))),
      ).size;
    }

    const { role, topicDate } = classifyTopic(session.topic, topicRules);
    const eventKey = eventKeyFor(role, topicDate, session.start_time, topicRules);

    try {
      await pgRpc<number>(pg, "upsert_zoom_sessions", {
        p_rows: [
          {
            session_uuid: session.uuid,
            zoom_id: session.id,
            session_type: session.type,
            topic: session.topic,
            start_time: session.start_time,
            end_time: session.end_time,
            duration_min: session.duration,
            host_email: session.host_email,
            host_id: session.host_id,
            total_registrants: registrants,
            total_attendees: attendees,
            participants_status: fetched.status,
            participants_note: fetched.note,
            session_role: role,
            topic_date: topicDate,
            event_key: eventKey,
          },
        ],
      });
      sessionsWritten += 1;
    } catch (e) {
      warnings.push(`session write ${session.uuid}: ${safeMessage(e)}`);
      continue;
    }


    for (let i = 0; i < rows.length; i += 500) {
      const slice = rows.slice(i, i + 500);
      participantRows += (await pgRpc<number>(pg, "upsert_zoom_participants", { p_rows: slice })) ?? 0;
    }
    totalSegments += rows.length;
    invalidRows += rows.length - rows.filter((r) => r.is_valid).length;
  }

  if (participantErrors.length > 0) {
    warnings.push(
      `participant reports: ${participantErrors.length} of ${matched.length} session(s) could not be fetched. First error: ${participantErrors[0]}`,
    );
    // Attribute each refusal to the source it actually came from.
    for (const [marker, target] of [
      ["/report/webinars/", webinarStatus],
      ["/report/meetings/", meetingStatus],
    ] as const) {
      const hit = participantErrors.find((m) => m.includes(marker) && m.includes("does not contain scopes"));
      if (!hit) continue;
      const names = hit.match(/scopes:\[([^\]]+)\]/)?.[1] ?? "";
      target.missingScopes = Array.from(
        new Set([...(target.missingScopes ?? []), ...names.split(",").map((s) => s.trim()).filter(Boolean)]),
      );
      target.note = `Sessions are listing fine, but attendance is refused — your app is missing the scope ${names}. Add it at marketplace.zoom.us → Manage → your app → Scopes, then Save and re-activate the app.`;
    }

  }


  const status: ZoomSyncResult["status"] =
    warnings.length === 0 ? "success" : sessionsWritten > 0 || matched.length === 0 ? "partial" : "error";

  return finish({
    status,
    since,
    until,
    sessionsMatched: matched.length,
    sessionsIgnored: ignored.length,
    participantRowsWritten: participantRows,
    invalidRows,
    invalidPct: totalSegments > 0 ? (invalidRows / totalSegments) * 100 : null,
    earliestSession: earliest,
    latestSession: latest,
    topicMatch,
    rowsWritten: sessionsWritten + participantRows,
    error: warnings.length ? warnings.join(" | ") : null,
    warnings,
    sources: sourceStatuses,
  });
}

/**
 * One-off / weekly repair pass: recover the host on sessions Zoom listed
 * without one, and translate host_id-only sessions into emails. Kept out of the
 * 6-hourly sync because it walks history one definition at a time.
 */
export async function runZoomHostBackfill(limit = 500): Promise<{
  status: "success" | "error";
  scanned: number;
  recovered: number;
  unrecoverable: number;
  emailsResolved: number;
  unresolvedHostIds: string[];
  byHost: Record<string, number>;
  notes: string[];
  error: string | null;
}> {
  const empty = {
    scanned: 0,
    recovered: 0,
    unrecoverable: 0,
    emailsResolved: 0,
    unresolvedHostIds: [] as string[],
    byHost: {} as Record<string, number>,
    notes: [] as string[],
  };
  const pg = getPg();
  if (!pg)
    return { status: "error", ...empty, error: "Lovable Cloud backend is not configured for this project yet." };
  try {
    const token = await getToken();
    const fetchJson = async <T,>(path: string) => {
      const out = await zoomGet<T>(path, token, { tolerate: [400, 404] });
      if (out === null) throw new Error(`Zoom has no record for ${path}`);
      return out;
    };
    const fill = await backfillSessionHosts(pg, fetchJson, encodeZoomUuid, limit);
    const emails = await resolveHostEmails(pg, fetchJson);
    if (fill.recovered > 0 || emails.resolved > 0) await analyzeAfterWrite(pg, ["zoom_sessions"]);
    return {
      status: "success",
      scanned: fill.scanned,
      recovered: fill.recovered,
      unrecoverable: fill.unrecoverable,
      emailsResolved: emails.resolved,
      unresolvedHostIds: emails.unresolved,
      byHost: fill.byHost,
      notes: fill.notes,
      error: null,
    };
  } catch (e) {
    return { status: "error", ...empty, error: safeMessage(e) };
  }
}
