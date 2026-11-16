import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeMessage } from "./safe-error";

export type ParticipantsStatus = "fetched" | "empty" | "failed" | "unavailable" | null;

export type ZoomSessionRow = {
  session_uuid: string;
  zoom_id: string | null;
  session_type: string;
  topic: string | null;
  start_time: string | null;
  business_date: string | null;
  duration_min: number | null;
  total_registrants: number | null;
  attendees: number | null;
  invalid_rows: number | null;
  at_30: number | null;
  at_60: number | null;
  at_90: number | null;
  session_role: string | null;
  topic_date: string | null;
  event_key: string | null;
  participants_status: ParticipantsStatus;
  participants_note: string | null;
};

export type ZoomEventRow = {
  event_key: string;
  event_date: string | null;
  sessions: number;
  live_sessions: number;
  replay_sessions: number;
  registrants: number | null;
  attendees: number | null;
  /** Attendees counted only on sessions that also reported a registrant count. */
  attendees_matched: number | null;
  sessions_without_registrants: number;
  at_30: number | null;
  at_60: number | null;
  at_90: number | null;
  sessions_missing_attendance: number;
  first_start: string | null;
};

export type IgnoredSessionRow = {
  session_uuid: string;
  zoom_id: string | null;
  session_type: string | null;
  topic: string | null;
  start_time: string | null;
  host_email: string | null;
};

export type SourceStatus = {
  source: string;
  label: string;
  available: boolean;
  note: string | null;
  missingScopes: string[];
  sessionsReturned: number;
  matched: number;
  ignored: number;
  hosts: string[];
};

export type WebinarsData = {
  configured: boolean;
  sources: SourceStatus[];
  sourcesCheckedAt: string | null;
  sessions: ZoomSessionRow[];
  events: ZoomEventRow[];
  includeTest: boolean;
  ignored: IgnoredSessionRow[];
  ignoredCount: number;
  topicMatch: string | null;
  topicMatchDescription: string | null;
  /** Business dates on which no webinar was scheduled — a fact, not a gap. */
  offDays: string[];
  lastRun: {
    started_at: string;
    finished_at: string | null;
    status: string | null;
    rows_written: number | null;
    error: string | null;
    source: string | null;
  } | null;
  error: string | null;
};

export type ZoomSyncSummary = {
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
  error: string | null;
  sources: SourceStatus[];
};

export const getWebinars = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) =>
    z
      .object({
        since: z.string().optional(),
        until: z.string().optional(),
        includeTest: z.boolean().optional(),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data }): Promise<WebinarsData> => {
    const { getPg, pgRpc, pgSelect } = await import("./pg.server");
    const pg = getPg();
    const includeTest = data.includeTest ?? false;
    const empty: WebinarsData = {
      configured: false,
      sources: [],
      sourcesCheckedAt: null,
      sessions: [],
      events: [],
      includeTest,
      ignored: [],
      ignoredCount: 0,
      topicMatch: null,
      topicMatchDescription: null,
      offDays: [],
      lastRun: null,
      error: null,
    };
    if (!pg) return empty;

    const until = data.until ?? new Date().toISOString().slice(0, 10);
    const since = data.since ?? "2025-09-01";

    try {
      const [sessions, events, ignored, settings, runs] = await Promise.all([
        pgRpc<ZoomSessionRow[]>(pg, "zoom_session_rows", {
          p_start: since,
          p_end: until,
          p_include_test: includeTest,
        }),
        pgRpc<ZoomEventRow[]>(pg, "zoom_event_rows", {
          p_start: since,
          p_end: until,
          p_include_test: includeTest,
        }),

        pgSelect<IgnoredSessionRow[]>(
          pg,
          "/zoom_ignored_sessions?select=session_uuid,zoom_id,session_type,topic,start_time,host_email&order=start_time.desc&limit=500",
        ),
        pgSelect<{ key: string; value: string | null; description: string | null }[]>(
          pg,
          "/app_settings?select=key,value,description&key=in.(zoom_l1_topic_match,zoom_source_status,webinar_off_days)&order=key.asc",
        ),
        pgSelect<WebinarsData["lastRun"][]>(
          pg,
          "/sync_runs?select=started_at,finished_at,status,rows_written,error,source&source=like.zoom*&order=started_at.desc&limit=1",
        ),
      ]);

      const topicRow = settings?.find((r) => r.key === "zoom_l1_topic_match") ?? null;
      const statusRow = settings?.find((r) => r.key === "zoom_source_status") ?? null;
      const offRow = settings?.find((r) => r.key === "webinar_off_days") ?? null;
      const offDays = (offRow?.value ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
      let sources: SourceStatus[] = [];
      let sourcesCheckedAt: string | null = null;
      if (statusRow?.value) {
        try {
          const parsed = JSON.parse(statusRow.value) as {
            checked_at?: string;
            sources?: SourceStatus[];
          };
          sources = parsed.sources ?? [];
          sourcesCheckedAt = parsed.checked_at ?? null;
        } catch {
          sources = [];
        }
      }

      return {
        configured: true,
        sources,
        sourcesCheckedAt,
        sessions: sessions ?? [],
        events: events ?? [],
        includeTest,
        ignored: ignored ?? [],
        ignoredCount: ignored?.length ?? 0,
        topicMatch: topicRow?.value ?? null,
        topicMatchDescription: topicRow?.description ?? null,
        offDays,
        lastRun: runs?.[0] ?? null,
        error: null,
      };
    } catch (e) {
      return { ...empty, configured: true, error: safeMessage(e) };
    }
  });

export const getRetentionCurve = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ sessionUuid: z.string().min(1) }).parse(data))
  .handler(async ({ data }): Promise<{ minute: number; present: number }[]> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return [];
    const rows = await pgRpc<{ minute: number; present: number }[]>(pg, "zoom_retention_curve", {
      p_session_uuid: data.sessionUuid,
    });
    return rows ?? [];
  });

export const saveTopicMatch = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => z.object({ value: z.string().min(2).max(200) }).parse(data))
  .handler(async ({ data }): Promise<{ value: string }> => {
    const { getPg, pgUpdate } = await import("./pg.server");
    const pg = getPg();
    if (!pg) throw new Error("Database is not configured.");
    const value = data.value.trim().toLowerCase();
    if (!value) throw new Error("The topic filter cannot be empty.");
    await pgUpdate(pg, "app_settings", "key=eq.zoom_l1_topic_match", {
      value,
      updated_at: new Date().toISOString(),
    });
    return { value };
  });

export const triggerZoomSync = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        since: z.string().nullable().optional(),
        until: z.string().nullable().optional(),
      })
      .parse(data ?? {}),
  )
  .handler(async ({ data }): Promise<ZoomSyncSummary> => {
    const { runZoomSync } = await import("./zoom-sync.server");
    const result = await runZoomSync({
      since: data.since ?? null,
      until: data.until ?? null,
      source: "zoom-manual",
    });
    return {
      status: result.status,
      since: result.since,
      until: result.until,
      sessionsMatched: result.sessionsMatched,
      sessionsIgnored: result.sessionsIgnored,
      participantRowsWritten: result.participantRowsWritten,
      invalidRows: result.invalidRows,
      invalidPct: result.invalidPct,
      earliestSession: result.earliestSession,
      latestSession: result.latestSession,
      error: result.error,
      sources: result.sources,
    };
  });

/**
 * Owner-editable list of days on which no webinar was scheduled. Stored as a
 * comma-separated list of business dates in app_settings.webinar_off_days.
 */
export const saveOffDays = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z.object({ days: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)) }).parse(data),
  )
  .handler(async ({ data }): Promise<{ days: string[] }> => {
    const { getPg, pgUpdate } = await import("./pg.server");
    const pg = getPg();
    if (!pg) throw new Error("Database is not configured.");
    const days = Array.from(new Set(data.days)).sort();
    await pgUpdate(pg, "app_settings", "key=eq.webinar_off_days", {
      value: days.join(","),
      updated_at: new Date().toISOString(),
    });
    return { days };
  });

/** Read-only accessor for the off-day list, used by the Settings screen. */
export const getOffDays = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ days: string[] }> => {
    const { getPg, pgSelect } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return { days: [] };
    const rows = await pgSelect<{ value: string | null }[]>(
      pg,
      "/app_settings?select=value&key=eq.webinar_off_days",
    );
    const days = (rows?.[0]?.value ?? "")
      .split(",")
      .map((d) => d.trim())
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    return { days };
  },
);
