/**
 * THE TEAM SOURCE REGISTER, read daily from the team's own Google Sheet.
 *
 * The team writes one row per sale: who bought, and the source THEY know it
 * came from. It is the last layer of source truth — hard tracking evidence
 * still wins, then the ledger's own source column, then this register.
 *
 * Loading is an upsert on person + entry date, so re-reading the whole sheet
 * every night changes nothing for rows already stored and picks up the new
 * ones. Nothing here decides a sale or a rupee: the register only answers
 * "where did this person come from".
 */

import { getPg, pgInsert, pgRpc, pgSelect, pgUpdate, pgUpsert, type PgClient } from "./pg.server";
import { fetchSheetRange, type SheetRows } from "./google-sheets.server";
import { parseSheetDate } from "./ledger-sheet.server";
import { lastRawError, rawDetail, safeMessage } from "./safe-error";

const DEFAULT_SHEET_ID = "19azQVMk5lGEqvT85dXWI5OHs1JQWjMozt7jbs0wm4fY";
const DEFAULT_TAB = "Sales entries";

export const TEAM_REGISTER_SOURCE = "team-register";

/** Header text (first line, case-insensitive) → the field we store. */
const HEADERS = {
  entry_date: ["sale date", "entry date", "date"],
  student_name: ["student name", "name"],
  email: ["email", "email id"],
  alt_email: ["alternate email", "alt email"],
  phone_10digit: ["mobile", "phone", "mobile number"],
  team_source: ["primary first source", "team source", "primary source"],
  team_source_detail: ["source detail", "team source detail"],
  point_of_payment: ["point of payment"],
  webinar_attended: ["webinar date attended", "webinar attended"],
  notes: ["notes", "note"],
  filled_by: ["filled by"],
} as const;

type Field = keyof typeof HEADERS;

export type TeamRegisterSyncResult = {
  status: "ok" | "error";
  rowsRead: number;
  rowsUpserted: number;
  registerRows?: number;
  matchedSales?: number;
  headerRow?: number;
  refreshedSales?: number;
  error?: string;
};

function firstLine(s: unknown): string {
  return String(s ?? "").split("\n")[0]!.trim();
}

function norm(s: unknown): string {
  return firstLine(s).toLowerCase().replace(/\s+/g, " ");
}

async function setting(pg: PgClient, key: string, fallback: string): Promise<string> {
  const rows = await pgSelect<{ value: string | null }[]>(
    pg,
    `/app_settings?key=eq.${encodeURIComponent(key)}&select=value`,
  );
  const value = rows[0]?.value;
  return value && value.trim() !== "" ? value.trim() : fallback;
}

/** Finds the header row and maps each field to its column index. */
function resolveHeader(probe: SheetRows) {
  for (let i = 0; i < probe.length; i += 1) {
    const cells = (probe[i] ?? []).map(norm);
    const cols = {} as Record<Field, number | null>;
    let hits = 0;
    for (const [field, names] of Object.entries(HEADERS) as [Field, readonly string[]][]) {
      const at = cells.findIndex((c) => names.some((n) => c === n || c.startsWith(`${n} `) || c.startsWith(`${n}(`)));
      cols[field] = at === -1 ? null : at;
      if (at !== -1) hits += 1;
    }
    if (hits >= 5 && cols.entry_date !== null && cols.team_source !== null) {
      return { headerRow: i + 1, cols };
    }
  }
  throw new Error(
    'Could not find the register header row — expected a row containing "Sale date" and "Primary FIRST source".',
  );
}

const PAGE = 2000;
const LOAD_BATCH = 500;

export async function runTeamRegisterSync(): Promise<TeamRegisterSyncResult> {
  const pg = getPg();
  if (!pg) {
    return { status: "error", rowsRead: 0, rowsUpserted: 0, error: "Database is not configured" };
  }

  const run = await pgInsert<{ id: string }[]>(pg, "sync_runs", {
    source: TEAM_REGISTER_SOURCE,
    started_at: new Date().toISOString(),
    status: "running",
  });
  const runId = run?.[0]?.id;

  const finish = async (result: TeamRegisterSyncResult) => {
    if (runId) {
      await pgUpdate(pg, "sync_runs", `id=eq.${runId}`, {
        finished_at: new Date().toISOString(),
        rows_written: result.rowsUpserted,
        status: result.status === "ok" ? "ok" : "error",
        error: result.error ?? null,
        // Owner rule, 14 Sep: a failure that stores no detail is a failure
        // nobody can diagnose. The verbatim text always lands here.
        error_detail: result.error ? (lastRawError() ?? result.error) : null,
      });
    }
    return result;
  };

  try {
    const sheetId = await setting(pg, "team_register_sheet_id", DEFAULT_SHEET_ID);
    const tab = await setting(pg, "team_register_tab", DEFAULT_TAB);

    const probe = await fetchSheetRange(sheetId, tab, "A1:AZ20");
    const { headerRow, cols } = resolveHeader(probe);

    let cursor = headerRow + 1;
    let rowsRead = 0;
    let rowsUpserted = 0;

    for (;;) {
      const values = await fetchSheetRange(sheetId, tab, `A${cursor}:AZ${cursor + PAGE - 1}`);
      if (values.length === 0) break;

      const batch: Record<string, unknown>[] = [];
      for (const row of values) {
        const at = (idx: number | null) => (idx === null ? null : (row[idx] ?? null));
        const entryDate = parseSheetDate(at(cols.entry_date));
        const name = firstLine(at(cols.student_name));
        const email = firstLine(at(cols.email));
        const phone = firstLine(at(cols.phone_10digit));
        // A row with no date, or with nothing that can identify a person, is a
        // spacer — never a register entry.
        if (!entryDate) continue;
        if (!email && !phone && !name) continue;
        rowsRead += 1;

        const detail = [firstLine(at(cols.team_source_detail)), firstLine(at(cols.point_of_payment))]
          .filter(Boolean)
          .join(" | ");
        const notes = [firstLine(at(cols.notes)), firstLine(at(cols.filled_by))]
          .filter(Boolean)
          .join(" | ");

        batch.push({
          entry_date: entryDate,
          student_name: name,
          email,
          alt_email: firstLine(at(cols.alt_email)),
          phone_10digit: phone,
          team_source: firstLine(at(cols.team_source)),
          team_source_detail: detail,
          webinar_attended: firstLine(at(cols.webinar_attended)),
          notes,
        });
      }

      for (let i = 0; i < batch.length; i += LOAD_BATCH) {
        const slice = batch.slice(i, i + LOAD_BATCH);
        const n = await pgRpc<number>(pg, "load_team_register", { p_rows: slice });
        rowsUpserted += Number(n ?? 0);
      }

      if (values.length < PAGE) break;
      cursor += PAGE;
    }

    await pgUpsert(pg, "app_settings", {
      key: "team_register_last_sync",
      value: new Date().toISOString(),
      description: "Last successful team source register import",
      updated_at: new Date().toISOString(),
    });

    // The register is a source layer, so the stored attribution the Sources
    // screen reads has to be rebuilt once new rows land. Never fatal.
    let refreshedSales: number | undefined;
    try {
      const { refreshSourcePrecompute } = await import("./source-precompute.server");
      const refreshed = await refreshSourcePrecompute();
      refreshedSales = refreshed.sales;
      if (refreshed.status !== "success") {
        console.error("[EQH] register precompute refresh:", refreshed.status, refreshed.error);
      }
    } catch (e) {
      console.error("[EQH] register precompute refresh failed:", rawDetail(e, 300));
    }

    const counts = await pgRpc<{ register_rows: number; matched_sales: number }[]>(
      pg,
      "team_register_counts",
      {},
    ).catch((e) => {
      console.error("[EQH] register counts failed:", rawDetail(e, 300));
      return [] as { register_rows: number; matched_sales: number }[];
    });

    return await finish({
      status: "ok",
      rowsRead,
      rowsUpserted,
      headerRow,
      ...(counts[0]?.register_rows === undefined ? {} : { registerRows: counts[0].register_rows }),
      ...(counts[0]?.matched_sales === undefined ? {} : { matchedSales: counts[0].matched_sales }),
      ...(refreshedSales === undefined ? {} : { refreshedSales }),
    });
  } catch (e) {
    return await finish({
      status: "error",
      rowsRead: 0,
      rowsUpserted: 0,
      error: safeMessage(e, "team-register"),
    });
  }
}
