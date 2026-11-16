/**
 * Zoom cloud recordings → zoom_recordings + Supabase storage.
 *
 * WHY THIS EXISTS AT ALL: Zoom deletes cloud recordings on the account's
 * retention schedule and its download links expire. A recording not captured
 * today is gone forever, so this job runs ahead of any analysis capability —
 * it CAPTURES ONLY. Nothing here transcribes, summarises or scores anything.
 *
 * Rules kept from the rest of the Zoom pipeline:
 *  1. Only sessions the topic filter already matched (rows in zoom_sessions)
 *     are asked about — no fishing across the whole account.
 *  2. A refused scope degrades this job alone and reports the EXACT scope
 *     names Zoom demands; it never guesses and never fails the Zoom sync.
 *  3. Small files (audio, chat, transcripts) are persisted as bytes. Large
 *     video files keep their link plus its expiry, and the row says so —
 *     a link is honestly marked 'link_only', never presented as a saved file.
 */

import {
  breakerState,
  isTransient,
  LOAD_LIMITS,
  makePacer,
  tripBreaker,
  analyzeAfterWrite,
} from "./load-guard.server";
import { getPg, pgInsert, pgSelect, pgUpdate, pgUpsert, type PgClient } from "./pg.server";
import { encodeZoomUuid, extractMissingScopes, ZoomApiError } from "./zoom-sync.server";
import { lastRawError, safeMessage } from "./safe-error";

const ZOOM_API = "https://api.zoom.us/v2";
const BUCKET = "zoom-recordings";

/** Files we persist as bytes. Video is link-only unless it is small. */
const ALWAYS_PERSIST = new Set(["audio_only", "chat_file", "closed_caption", "timeline", "cc_transcript", "transcript", "audio_transcript"]);
/** Hard ceiling for a single download in one pass (bucket limit is 2 GB). */
const MAX_PERSIST_BYTES = 1_500_000_000;

/** Transcript-bearing file types Zoom emits. Captured before anything else. */
export const TRANSCRIPT_TYPES = new Set(["audio_transcript", "closed_caption", "cc_transcript", "transcript"]);

export type RecordingCaptureResult = {
  status: "success" | "partial" | "error" | "skipped";
  sessionsChecked: number;
  sessionsWithRecordings: number;
  filesSeen: number;
  filesStored: number;
  filesLinkOnly: number;
  bytesStored: number;
  transcriptsStored: number;
  transcriptCues: number;
  missingScopes: string[];
  error: string | null;
  warnings: string[];
};

type ZoomRecordingFile = {
  id?: string;
  recording_type?: string;
  file_type?: string;
  file_extension?: string;
  file_size?: number;
  download_url?: string;
  play_url?: string;
  recording_start?: string;
  recording_end?: string;
  status?: string;
};

type ZoomRecordingBody = {
  uuid?: string;
  start_time?: string;
  host_id?: string;
  host_email?: string;
  recording_files?: ZoomRecordingFile[];
};

async function getToken() {
  const accountId = process.env["ZOOM_ACCOUNT_ID"];
  const clientId = process.env["ZOOM_CLIENT_ID"];
  const clientSecret = process.env["ZOOM_CLIENT_SECRET"];
  if (!accountId || !clientId || !clientSecret) {
    throw new Error(
      "Missing Zoom Server-to-Server credentials (ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET).",
    );
  }
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    { method: "POST", headers: { Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}` } },
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Zoom OAuth failed (${res.status}): ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { access_token?: string };
  if (!body.access_token) throw new Error("Zoom OAuth returned no access_token");
  return body.access_token;
}

async function zoomGetJson<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${ZOOM_API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (res.status === 404) return null;
  if (!res.ok) throw new ZoomApiError(res.status, path, text);
  return (text ? JSON.parse(text) : null) as T;
}

/** Upload bytes to the private recordings bucket via the storage REST API. */
async function putObject(pg: PgClient, path: string, body: ArrayBuffer, contentType: string) {
  const res = await fetch(`${pg.url}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: pg.key,
      Authorization: `Bearer ${pg.key}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`storage upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

/** Reads a file we already hold in storage, so a re-parse costs no Zoom call. */
async function getStoredText(pg: PgClient, storagePath: string): Promise<string | null> {
  const path = storagePath.startsWith(`${BUCKET}/`)
    ? storagePath.slice(BUCKET.length + 1)
    : storagePath;
  const res = await fetch(`${pg.url}/storage/v1/object/${BUCKET}/${path}`, {
    headers: { apikey: pg.key, Authorization: `Bearer ${pg.key}` },
  });
  if (!res.ok) return null;
  return await res.text();
}


function extensionOf(file: ZoomRecordingFile) {
  const raw = file.file_extension ?? file.file_type ?? "";
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
}

function contentTypeFor(ext: string) {
  if (ext === "m4a" || ext === "mp4a") return "audio/mp4";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "mp4") return "video/mp4";
  if (ext === "vtt") return "text/vtt";
  if (ext === "txt") return "text/plain";
  if (ext === "json") return "application/json";
  return "application/octet-stream";
}


/** One timestamped line of a Zoom VTT transcript. */
export type TranscriptCue = {
  cue_index: number;
  start_ms: number;
  end_ms: number;
  speaker: string | null;
  text: string;
};

function tsToMs(stamp: string): number | null {
  // 00:12:34.567 or 12:34.567
  const m = stamp.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) return null;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number((m[4] ?? "0").padEnd(3, "0"));
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/**
 * Parse a WEBVTT transcript into cues. Zoom writes the speaker as a
 * "Name: text" prefix when audio transcription is on; when it is absent the
 * speaker stays null rather than being guessed.
 */
export function parseVtt(raw: string): TranscriptCue[] {
  const lines = raw.replace(/\r/g, "").split("\n");
  const cues: TranscriptCue[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const arrow = line.indexOf("-->");
    if (arrow === -1) {
      i += 1;
      continue;
    }
    const start = tsToMs(line.slice(0, arrow));
    const end = tsToMs((line.slice(arrow + 3).trim().split(/\s+/)[0] ?? ""));
    i += 1;
    const parts: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "") {
      parts.push((lines[i] ?? "").trim());
      i += 1;
    }
    if (start === null || end === null || parts.length === 0) continue;
    let text = parts.join(" ").replace(/<[^>]+>/g, "").trim();
    let speaker: string | null = null;
    const sp = text.match(/^([^:]{1,60}):\s+(.*)$/);
    if (sp && sp[1] && !/^https?$/i.test(sp[1])) {
      speaker = sp[1].trim();
      text = (sp[2] ?? "").trim();
    }
    if (!text) continue;
    cues.push({ cue_index: cues.length, start_ms: start, end_ms: end, speaker, text });
  }
  return cues;
}

/** Store a parsed transcript: one header row plus its timestamped lines. */
async function storeTranscript(
  pg: PgClient,
  args: {
    sessionRef: string;
    recordingId: string;
    sourceType: string;
    storagePath: string;
    raw: string;
  },
): Promise<number> {
  const cues = parseVtt(args.raw);
  const header = await pgUpsert<{ id: string }[]>(
    pg,
    "recording_transcripts?on_conflict=session_ref,recording_id",
    {
      session_ref: args.sessionRef,
      recording_id: args.recordingId,
      source_type: args.sourceType,
      storage_path: args.storagePath,
      cue_count: cues.length,
      duration_ms: cues.length ? (cues[cues.length - 1]?.end_ms ?? null) : null,
      full_text: cues.map((c) => (c.speaker ? `${c.speaker}: ${c.text}` : c.text)).join("\n"),
      updated_at: new Date().toISOString(),
    },
  );
  const transcriptId = header?.[0]?.id;
  if (!transcriptId || cues.length === 0) return 0;
  for (let i = 0; i < cues.length; i += 500) {
    // PostgREST accepts an array body for a bulk upsert.
    await pgUpsert(
      pg,
      "recording_transcript_cues?on_conflict=transcript_id,cue_index",
      cues.slice(i, i + 500).map((c) => ({ ...c, transcript_id: transcriptId })),
    );
  }
  return cues.length;
}

/**
 * Capture recordings for sessions already known to zoom_sessions.
 *
 * @param opts.since  ISO date; sessions started on or after this are checked.
 * @param opts.limit  Max sessions in one pass (the job is resumable by design —
 *                    it re-checks anything not yet marked stored/link_only).
 */
export async function runRecordingCapture(opts: {
  since?: string | null;
  limit?: number;
  source?: string;
  /** Oldest sessions first — Zoom expires cloud recordings, so age wins. */
  oldestFirst?: boolean;
}): Promise<RecordingCaptureResult> {

  const base: RecordingCaptureResult = {
    status: "error",
    sessionsChecked: 0,
    sessionsWithRecordings: 0,
    filesSeen: 0,
    filesStored: 0,
    filesLinkOnly: 0,
    bytesStored: 0,
    transcriptsStored: 0,
    transcriptCues: 0,
    missingScopes: [],
    error: null,
    warnings: [],
  };

  const pg = getPg();
  if (!pg) return { ...base, error: "Lovable Cloud backend is not configured for this project yet." };

  // Load protection: stand down while the shared breaker is open, and never
  // ask for more sessions in one pass than the batch cap allows.
  const breaker = await breakerState(pg);
  if (breaker.open) {
    return {
      ...base,
      status: "skipped",
      warnings: [
        `Standing down until ${breaker.until ?? "the database recovers"} — ${breaker.reason ?? "the database was struggling"}. Nothing was captured; the next run resumes.`,
      ],
      error: null,
    };
  }

  const since = opts.since ?? new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const limit = Math.min(opts.limit ?? 25, LOAD_LIMITS.BATCH_CAP);
  const pace = makePacer();


  const run = await pgInsert<{ id: string }[]>(pg, "sync_runs", {
    source: opts.source ?? "zoom-recordings",
    status: "running",
  });
  const runId = run?.[0]?.id;

  const warnings: string[] = [];
  const missingScopes = new Set<string>();
  let token: string;
  try {
    token = await getToken();
  } catch (e) {
    const result = { ...base, error: safeMessage(e) };
    if (runId) {
      await pgUpdate(pg, "sync_runs", `id=eq.${runId}`, {
        finished_at: new Date().toISOString(),
        status: "error",
        error: result.error,
        error_detail: result.error ? (lastRawError() ?? result.error) : null,
      });
    }
    return result;
  }

  const sessions =
    (await pgSelect<{ session_uuid: string; topic: string | null; start_time: string | null; host_email: string | null }[]>(
      pg,
      `/zoom_sessions?select=session_uuid,topic,start_time,host_email&start_time=gte.${since}T00:00:00Z&order=start_time.${opts.oldestFirst ? "asc" : "desc"}&limit=${limit}`,
    )) ?? [];

  let filesSeen = 0;
  let filesStored = 0;
  let filesLinkOnly = 0;
  let bytesStored = 0;
  let sessionsWithRecordings = 0;
  let transcriptsStored = 0;
  let transcriptCues = 0;

  let dbTrouble = 0;
  for (const session of sessions) {
    await pace(); // leave headroom for the interactive screens
    let body: ZoomRecordingBody | null;
    try {
      body = await zoomGetJson<ZoomRecordingBody>(
        `/meetings/${encodeZoomUuid(session.session_uuid)}/recordings`,
        token,
      );
    } catch (e) {
      const scopes = e instanceof Error ? extractMissingScopes(e.message) : [];
      if (scopes.length) {
        scopes.forEach((s) => missingScopes.add(s));
        // A refused scope is refused for every session — stop asking.
        warnings.push(
          `Zoom refused the recordings endpoint for want of scope(s): ${scopes.join(", ")}. Nothing was captured.`,
        );
        break;
      }
      if (isTransient(e)) dbTrouble += 1;
      warnings.push(`session ${session.session_uuid}: ${safeMessage(e)}`);
      if (dbTrouble >= 3) {
        const until = await tripBreaker(pg, `recording capture: ${safeMessage(e)}`);
        warnings.push(
          `Stopped early — the database kept refusing. Heavy jobs stand down until ${until}; the next run resumes from the same point.`,
        );
        break;
      }
      continue;

    }

    // Record the host id Zoom reports, for per-host scorecards later.
    if (body?.host_id) {
      try {
        await pgUpdate(pg, "zoom_sessions", `session_uuid=eq.${encodeURIComponent(session.session_uuid)}`, {
          host_id: body.host_id,
        });
      } catch {
        /* host id is a nice-to-have; never block capture on it */
      }
    }

    // Transcripts first: they are small, they expire with the same link, and
    // they are the thing the owner is waiting for.
    const files = [...(body?.recording_files ?? [])].sort((a, b) => {
      const at = TRANSCRIPT_TYPES.has((a.recording_type ?? "").toLowerCase()) ? 0 : 1;
      const bt = TRANSCRIPT_TYPES.has((b.recording_type ?? "").toLowerCase()) ? 0 : 1;
      return at - bt;
    });
    if (files.length === 0) continue;
    sessionsWithRecordings += 1;

    for (const file of files) {
      filesSeen += 1;
      const recordingId = file.id ?? `${file.recording_type ?? "file"}-${file.recording_start ?? ""}`;
      const ext = extensionOf(file);
      const type = (file.recording_type ?? file.file_type ?? "unknown").toLowerCase();
      const size = typeof file.file_size === "number" ? file.file_size : null;
      const recordedAt = file.recording_start ?? body?.start_time ?? session.start_time;

      // Zoom download links carry a short life; record when we saw them.
      const rowBase = {
        session_ref: session.session_uuid,
        recording_id: recordingId,
        recording_type: type,
        file_extension: ext,
        file_size: size,
        download_url: file.download_url ?? null,
        play_url: file.play_url ?? null,
        url_expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        recorded_at: recordedAt,
        recording_start: file.recording_start ?? null,
        recording_end: file.recording_end ?? null,
        updated_at: new Date().toISOString(),
      };

      const isTranscript = TRANSCRIPT_TYPES.has(type);

      const existing =
        (await pgSelect<{ status: string; storage_path: string | null }[]>(
          pg,
          `/zoom_recordings?select=status,storage_path&session_ref=eq.${encodeURIComponent(session.session_uuid)}&recording_id=eq.${encodeURIComponent(recordingId)}`,
        )) ?? [];

      if (existing[0]?.status === "stored") {
        // A stored FILE is not a parsed transcript. Before skipping, make sure
        // the transcript rows actually exist — otherwise re-parse the copy we
        // already hold in storage rather than downloading it from Zoom again.
        if (isTranscript) {
          const already =
            (await pgSelect<{ id: string }[]>(
              pg,
              `/recording_transcripts?select=id&recording_id=eq.${encodeURIComponent(recordingId)}&limit=1`,
            )) ?? [];
          if (already.length === 0) {
            const storedPath = existing[0]?.storage_path ?? null;
            try {
              const raw = storedPath ? await getStoredText(pg, storedPath) : null;
              if (raw) {
                const cueCount = await storeTranscript(pg, {
                  sessionRef: session.session_uuid,
                  recordingId,
                  sourceType: type,
                  storagePath: storedPath!,
                  raw,
                });
                transcriptsStored += 1;
                transcriptCues += cueCount;
                filesStored += 1;
                continue;
              }
            } catch (e) {
              warnings.push(
                `transcript ${recordingId} is stored but could not be re-read: ${safeMessage(e)}`,
              );
            }
            // No usable stored copy — fall through and fetch it from Zoom.
          } else {
            filesStored += 1;
            continue;
          }
        } else {
          filesStored += 1;
          continue;
        }
      }


      const persist =
        !!file.download_url &&
        (isTranscript || ALWAYS_PERSIST.has(type) || (size !== null && size <= MAX_PERSIST_BYTES));

      if (!persist) {
        await pgUpsert(pg, "zoom_recordings?on_conflict=session_ref,recording_id", {
          ...rowBase,
          status: "link_only",
          note: file.download_url
            ? "Too large to persist in one pass — the Zoom link is kept and expires; re-run capture to retry."
            : "Zoom returned no download link for this file.",
        });
        filesLinkOnly += 1;
        continue;
      }

      try {
        const res = await fetch(`${file.download_url}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`download failed (${res.status})`);
        const bytes = await res.arrayBuffer();
        const path = `${session.session_uuid.replace(/[^A-Za-z0-9]/g, "_")}/${recordingId.replace(/[^A-Za-z0-9._-]/g, "_")}.${ext}`;
        await putObject(pg, path, bytes, contentTypeFor(ext));
        if (isTranscript) {
          try {
            const cueCount = await storeTranscript(pg, {
              sessionRef: session.session_uuid,
              recordingId,
              sourceType: type,
              storagePath: `${BUCKET}/${path}`,
              raw: new TextDecoder().decode(bytes),
            });
            transcriptsStored += 1;
            transcriptCues += cueCount;
          } catch (e) {
            warnings.push(`transcript ${recordingId} stored as a file but could not be parsed: ${safeMessage(e)}`);
          }
        }
        await pgUpsert(pg, "zoom_recordings?on_conflict=session_ref,recording_id", {
          ...rowBase,
          storage_path: `${BUCKET}/${path}`,
          file_size: size ?? bytes.byteLength,
          status: "stored",
          note: null,
        });
        filesStored += 1;
        bytesStored += bytes.byteLength;
      } catch (e) {
        await pgUpsert(pg, "zoom_recordings?on_conflict=session_ref,recording_id", {
          ...rowBase,
          status: "failed",
          note: safeMessage(e),
        });
        warnings.push(`file ${recordingId}: ${safeMessage(e)}`);
      }
    }
  }

  const status: RecordingCaptureResult["status"] =
    missingScopes.size > 0 ? "error" : warnings.length > 0 ? "partial" : "success";

  const result: RecordingCaptureResult = {
    status,
    sessionsChecked: sessions.length,
    sessionsWithRecordings,
    filesSeen,
    filesStored,
    filesLinkOnly,
    bytesStored,
    transcriptsStored,
    transcriptCues,
    missingScopes: Array.from(missingScopes),
    error: warnings.length ? warnings.join(" | ") : null,
    warnings,
  };

  if (filesStored + filesLinkOnly > 0) {
    await analyzeAfterWrite(pg, ["zoom_recordings", "recording_transcripts", "recording_transcript_cues"]);
  }

  if (runId) {
    await pgUpdate(pg, "sync_runs", `id=eq.${runId}`, {
      finished_at: new Date().toISOString(),
      rows_written: filesStored + filesLinkOnly,
      status: result.status,
      error: result.error,
      error_detail: result.error ? (lastRawError() ?? result.error) : null,
    });
  }
  return result;
}

/**
 * LOOK FIRST, CAPTURE SECOND.
 *
 * Reports exactly what Zoom holds for the most recent matched L1 session:
 * which file types exist (video / audio / transcript / chat / none), and —
 * because a meeting can be recorded to the host's own account rather than the
 * matched session — what the host's cloud-recording list holds over the same
 * window. An empty list is reported as empty, which is itself the answer: the
 * recording was local, not cloud.
 */
export async function probeLatestRecording(opts: { since?: string | null } = {}): Promise<{
  status: "ok" | "scope_required" | "error";
  session: { session_uuid: string; topic: string | null; start_time: string | null; host_email: string | null } | null;
  fileTypes: string[];
  files: { recording_type: string; file_extension: string; file_size: number | null; status: string | null }[];
  hostRecordings: { count: number; meetings: { uuid: string; topic: string; start_time: string; file_types: string[] }[] } | null;
  missingScopes: string[];
  error: string | null;
}> {
  const out = {
    status: "error" as "ok" | "scope_required" | "error",
    session: null as null | { session_uuid: string; topic: string | null; start_time: string | null; host_email: string | null },
    fileTypes: [] as string[],
    files: [] as { recording_type: string; file_extension: string; file_size: number | null; status: string | null }[],
    hostRecordings: null as null | { count: number; meetings: { uuid: string; topic: string; start_time: string; file_types: string[] }[] },
    missingScopes: [] as string[],
    error: null as string | null,
  };

  const pg = getPg();
  if (!pg) return { ...out, error: "Lovable Cloud backend is not configured for this project yet." };

  const since = opts.since ?? new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  let token: string;
  try {
    token = await getToken();
  } catch (e) {
    return { ...out, error: safeMessage(e) };
  }

  const sessions =
    (await pgSelect<{ session_uuid: string; topic: string | null; start_time: string | null; host_email: string | null }[]>(
      pg,
      "/zoom_sessions?select=session_uuid,topic,start_time,host_email&order=start_time.desc&limit=1",
    )) ?? [];
  out.session = sessions[0] ?? null;

  const scopes = new Set<string>();

  if (out.session) {
    try {
      const body = await zoomGetJson<ZoomRecordingBody>(
        `/meetings/${encodeZoomUuid(out.session.session_uuid)}/recordings`,
        token,
      );
      const files = body?.recording_files ?? [];
      out.files = files.map((f) => ({
        recording_type: (f.recording_type ?? f.file_type ?? "unknown").toLowerCase(),
        file_extension: extensionOf(f),
        file_size: typeof f.file_size === "number" ? f.file_size : null,
        status: f.status ?? null,
      }));
      out.fileTypes = Array.from(new Set(out.files.map((f) => f.recording_type)));
    } catch (e) {
      const s = e instanceof Error ? extractMissingScopes(e.message) : [];
      s.forEach((x) => scopes.add(x));
      if (!s.length) out.error = safeMessage(e);
    }
  }

  // The per-meeting listing is what capture actually uses. Only fall back to
  // the account-wide listing when that returned nothing — that endpoint needs
  // a separate scope (cloud_recording:read:list_user_recordings) which is not
  // granted, and asking for it when we already have the files would report a
  // scope problem the job does not have.
  const host = out.session?.host_email ?? "me";
  if (scopes.size === 0 && out.files.length === 0) {
    try {
      const body = await zoomGetJson<{
        total_records?: number;
        meetings?: { uuid?: string; topic?: string; start_time?: string; recording_files?: ZoomRecordingFile[] }[];
      }>(`/users/${encodeURIComponent(host)}/recordings?from=${since}&page_size=30`, token);
      const meetings = body?.meetings ?? [];
      out.hostRecordings = {
        count: body?.total_records ?? meetings.length,
        meetings: meetings.map((m) => ({
          uuid: m.uuid ?? "",
          topic: m.topic ?? "",
          start_time: m.start_time ?? "",
          file_types: Array.from(
            new Set((m.recording_files ?? []).map((f) => (f.recording_type ?? f.file_type ?? "unknown").toLowerCase())),
          ),
        })),
      };
    } catch (e) {
      const s = e instanceof Error ? extractMissingScopes(e.message) : [];
      s.forEach((x) => scopes.add(x));
      if (!s.length && !out.error) out.error = safeMessage(e);
    }
  }

  out.missingScopes = Array.from(scopes);
  out.status = scopes.size ? "scope_required" : out.error ? "error" : "ok";
  return out;
}
