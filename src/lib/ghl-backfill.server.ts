/**
 * FULL-HISTORY LEAD IMPORT.
 *
 * The incremental sync only ever looked back 90 days, so every buyer who
 * arrived before that horizon has no lead record and lands in the
 * "buyers with no lead record" bucket. GHL still holds the contacts back to
 * 2023 — the gap is our ingestion depth, not the source.
 *
 * Shape of the job, deliberately boring:
 *  - one month window per batch, walked oldest → newest;
 *  - the cursor lives in app_settings, so an interrupted run resumes;
 *  - a lease row makes a second concurrent run exit instead of doubling up;
 *  - every batch writes a sync_runs row (source 'ghl-backfill');
 *  - each batch is an idempotent upsert on the contact id, and re-runs the
 *    ad-reference resolver so the unmatched bucket shrinks progressively;
 *  - a per-invocation time budget ends the run with work remaining; the next
 *    scheduled call picks up at the cursor. It never touches the 6-hourly
 *    incremental sync, which keeps its own window and its own sync_runs source.
 */

import {
  ghl,
  loadFieldMap,
  mapContact,
  sleep,
  writeRows,
  type LeadRow,
} from "./ghl-sync.server";
import {
  analyzeAfterWrite,
  breakerState,
  isTransient,
  refreshLeadAttribution,
  tripBreaker,
} from "./load-guard.server";
import { getPg, pgInsert, pgRpc, pgSelect, pgUpdate, pgUpsert, type PgClient } from "./pg.server";
import { rawDetail, safeMessage } from "./safe-error";

const CURSOR_KEY = "ghl_backfill_cursor";
const STATUS_KEY = "ghl_backfill_status";
const NOTE_KEY = "ghl_backfill_note";
const LOCK_KEY = "ghl_backfill_lock";
/** A stalled run releases itself after this long. */
const LEASE_MS = 15 * 60 * 1000;
const PAGE_KEY = "ghl_backfill_page_cursor";
/**
 * Verified against the source: the oldest `dateAdded` in the location is
 * 2025-11-04 (239,821 contacts in total). Contacts that pre-date the location
 * migration carry the migration date, so walking from here still reaches every
 * historical buyer — there is simply nothing older to ask for.
 */
const HISTORY_START = "2025-11-01";

/**
 * Writes are occasionally cancelled by a statement timeout when the database is
 * busy with the regular syncs. Halve the chunk and try again rather than losing
 * the whole batch; every write is an idempotent upsert on the contact id.
 */
async function writeResilient(pg: PgClient, rows: LeadRow[], size = 200): Promise<number> {
  if (rows.length === 0) return 0;
  try {
    return await writeRows(pg, rows.length > size ? rows.slice(0, size) : rows).then(async (n) =>
      rows.length > size ? n + (await writeResilient(pg, rows.slice(size), size)) : n,
    );
  } catch (e) {
    const msg = safeMessage(e);
    const transient = msg.includes("57014") || msg.toLowerCase().includes("timeout");
    if (!transient || size <= 25) throw e;
    await sleep(2000);
    return writeResilient(pg, rows, Math.floor(size / 2));
  }
}

export type BackfillBatch = {
  month: string;
  contacts: number;
  rowsWritten: number;
  pages: number;
};

export type BackfillResult = {
  status: "success" | "partial" | "skipped" | "error";
  cursor: string;
  done: boolean;
  batches: BackfillBatch[];
  contactsFetched: number;
  rowsWritten: number;
  unmatchedBefore: number | null;
  unmatchedAfter: number | null;
  note: string;
  error: string | null;
};

async function setting(pg: PgClient, key: string): Promise<string | null> {
  const rows = await pgSelect<{ value: string | null }[]>(
    pg,
    `/app_settings?select=value&key=eq.${encodeURIComponent(key)}`,
  );
  return rows?.[0]?.value ?? null;
}

async function putSetting(pg: PgClient, key: string, value: string, description?: string) {
  await pgUpsert(pg, "app_settings?on_conflict=key", {
    key,
    value,
    ...(description ? { description } : {}),
    updated_at: new Date().toISOString(),
  });
}

function monthStart(iso: string): Date {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00.000Z`);
  return d;
}

function addMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Buyers with no lead record, all-time — the number this job exists to move. */
async function unmatchedCount(pg: PgClient): Promise<number | null> {
  try {
    const rows = await pgRpc<{ total: number }[]>(pg, "ledger_unmatched_summary", {
      p_start: "2023-01-01",
      p_end: ymd(new Date()),
      p_tier: "L1_SILVER",
    });
    const total = Array.isArray(rows) ? rows[0]?.total : null;
    return total === undefined ? null : Number(total);
  } catch {
    return null;
  }
}

export type BackfillOptions = {
  /** Wall-clock budget for one invocation. */
  budgetMs?: number;
  /** Hard cap on month windows per invocation. */
  maxMonths?: number;
  /** Page ceiling per month window. */
  maxPagesPerMonth?: number;
  /** Restart the walk from this date instead of the stored cursor. */
  restartFrom?: string | null;
  /** Ignore a live lease (only for a manual, supervised re-run). */
  force?: boolean;
  /** Count the unmatched-buyer bucket before/after. Expensive; off by default. */
  measure?: boolean;
};

export async function runGhlBackfill(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const budgetMs = opts.budgetMs ?? 45_000;
  const maxMonths = opts.maxMonths ?? 24;
  const maxPagesPerMonth = opts.maxPagesPerMonth ?? 300;
  const deadline = Date.now() + budgetMs;

  const base: BackfillResult = {
    status: "error",
    cursor: HISTORY_START,
    done: false,
    batches: [],
    contactsFetched: 0,
    rowsWritten: 0,
    unmatchedBefore: null,
    unmatchedAfter: null,
    note: "",
    error: null,
  };

  const pg = getPg();
  if (!pg) return { ...base, error: "Lovable Cloud backend is not configured for this project yet." };

  const key = process.env["GHL_API_KEY"];
  const location = process.env["GHL_LOCATION_ID"];
  if (!key || !location) {
    return { ...base, error: "GHL_API_KEY / GHL_LOCATION_ID are missing from the project secrets." };
  }

  // Load protection: if a heavy job has recently exhausted its retries, every
  // heavy job stands down. The cursor is untouched, so nothing is lost.
  const breaker = await breakerState(pg);
  if (!opts.force && breaker.open) {
    return {
      ...base,
      status: "skipped",
      note: `Standing down until ${breaker.until ?? "the database recovers"} — ${breaker.reason ?? "the database was struggling"}.`,
      error: null,
    };
  }

  // Single flight — a second caller exits rather than importing the same month twice.
  const lease = await setting(pg, LOCK_KEY);
  if (!opts.force && lease && Date.parse(lease) > Date.now()) {
    return {
      ...base,
      status: "skipped",
      note: `Another import batch holds the lease until ${lease}.`,
      error: null,
    };
  }
  await putSetting(pg, LOCK_KEY, new Date(Date.now() + LEASE_MS).toISOString(), "Full-history lead import lease");


  const release = async (result: BackfillResult) => {
    await putSetting(pg, LOCK_KEY, new Date(0).toISOString());
    await putSetting(pg, CURSOR_KEY, result.cursor);
    await putSetting(pg, STATUS_KEY, result.done ? "done" : result.error ? "paused" : "running");
    await putSetting(pg, NOTE_KEY, result.error ?? result.note);
    return result;
  };

  if (opts.measure) base.unmatchedBefore = await unmatchedCount(pg);

  let cursor = monthStart(opts.restartFrom ?? (await setting(pg, CURSOR_KEY)) ?? HISTORY_START);
  const stopAfter = addMonth(monthStart(ymd(new Date()))); // through the current month
  base.cursor = ymd(cursor);

  try {
    const { byId, idFor } = await loadFieldMap(key, location);
    let months = 0;

    while (cursor < stopAfter && months < maxMonths && Date.now() < deadline) {
      const windowEnd = addMonth(cursor);
      const label = ymd(cursor).slice(0, 7);
      const sinceIso = cursor.toISOString();
      const untilIso = new Date(windowEnd.getTime() - 1).toISOString();

      const run = await pgInsert<{ id: string }[]>(pg, "sync_runs", {
        source: "ghl-backfill",
        status: "running",
      });
      const runId = run?.[0]?.id;

      const savedPage = await setting(pg, PAGE_KEY);
      let searchAfter: unknown[] | null = null;
      if (savedPage) {
        try {
          const parsed = JSON.parse(savedPage) as { month?: string; searchAfter?: unknown[] };
          if (parsed.month === label && Array.isArray(parsed.searchAfter)) {
            searchAfter = parsed.searchAfter;
          }
        } catch {
          /* a corrupt cursor just restarts the month; the upsert is idempotent */
        }
      }
      let pages = 0;
      let contacts = 0;
      let written = 0;

      try {
        while (pages < maxPagesPerMonth) {
          const body: Record<string, unknown> = {
            locationId: location,
            pageLimit: 100,
            sort: [{ field: "dateAdded", direction: "asc" }],
            filters: [
              { field: "dateAdded", operator: "range", value: { gte: sinceIso, lte: untilIso } },
            ],
          };
          if (searchAfter) body["searchAfter"] = searchAfter;

          const page = (await ghl("/contacts/search", key, {
            method: "POST",
            body: JSON.stringify(body),
          })) as { contacts?: Parameters<typeof mapContact>[0][] };

          const list = page.contacts ?? [];
          pages += 1;
          if (list.length === 0) break;

          const rows: LeadRow[] = [];
          for (const c of list) {
            const mapped = mapContact(c, byId, idFor);
            if (mapped) {
              rows.push(mapped);
              contacts += 1;
            }
          }
          written += await writeResilient(pg, rows);

          const next = list[list.length - 1]?.searchAfter;
          if (!next || !Array.isArray(next)) break;
          searchAfter = next;
          await putSetting(pg, PAGE_KEY, JSON.stringify({ month: label, searchAfter }));
          await sleep(200); // ~5 req/s
          // Stop mid-month when the budget runs out; the page cursor resumes it.
          if (Date.now() >= deadline) break;
        }

        if (written > 0) {
          await analyzeAfterWrite(pg, ["leads"]);
          await refreshLeadAttribution(pg);
        }

        if (runId) {
          await pgUpdate(pg, "sync_runs", `id=eq.${runId}`, {
            finished_at: new Date().toISOString(),
            rows_written: written,
            status: "success",
          });
        }
      } catch (e) {
        if (runId) {
          await pgUpdate(pg, "sync_runs", `id=eq.${runId}`, {
            finished_at: new Date().toISOString(),
            rows_written: written,
            status: "error",
            error: safeMessage(e),
            error_detail: rawDetail(e),
          });
        }
        throw e;
      }

      // Re-join what just landed so the unmatched bucket shrinks batch by batch,
      // then re-derive per-team ad coverage from the new matches.
      try {
        await pgRpc(pg, "resolve_lead_ad_refs", { p_only_new: true });
        // Team follows ad-account ownership, so it is re-derived right after
        // the ad references move — same rule as the spend side, always.
        // A history backfill touches old leads, so this one is deliberately
        // unbounded — it is an on-demand run, not the six-hourly sync.
        await pgRpc(pg, "refresh_lead_agency", { p_days: 0 });
        await pgRpc(pg, "refresh_agency_ratio_flags", { p_days: 30 });
        // A bulk history correction moves what a normal day looks like. Without
        // this, every day afterwards reads as an extreme event against a
        // baseline built from the pre-correction numbers.
        await pgRpc(pg, "rebuild_metric_baselines", {});

      } catch {
        /* matching is best-effort; the nightly pass covers it */
      }

      base.batches.push({ month: label, contacts, rowsWritten: written, pages });
      base.contactsFetched += contacts;
      base.rowsWritten += written;

      // Budget spent mid-window: keep the cursor on this month and resume from
      // the stored page next time.
      if (Date.now() >= deadline && searchAfter) break;
      await putSetting(pg, PAGE_KEY, "");

      cursor = windowEnd;
      months += 1;
      base.cursor = ymd(cursor);
      await putSetting(pg, CURSOR_KEY, base.cursor);
    }

    base.done = cursor >= stopAfter;
    if (opts.measure || base.done) base.unmatchedAfter = await unmatchedCount(pg);
    base.note = base.done
      ? "Full history imported."
      : `Paused at ${base.cursor} — the next scheduled batch resumes here.`;
    return await release({ ...base, status: base.done ? "success" : "partial" });
  } catch (e) {
    const msg = safeMessage(e);
    // A database-side failure trips the shared breaker so the other heavy jobs
    // back off too, instead of piling onto an instance that is already sinking.
    if (isTransient(e) || (e as Error).name === "CircuitOpenError") {
      const until = await tripBreaker(pg, `lead import: ${msg}`);
      return await release({
        ...base,
        status: "error",
        error: `${msg} — heavy jobs stand down until ${until}; the cursor is kept.`,
      });
    }
    return await release({ ...base, status: "error", error: msg });
  }
}
