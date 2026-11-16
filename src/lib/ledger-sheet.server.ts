/**
 * The authoritative collections ledger.
 *
 * Source of truth for every rupee and every sale count is the accounts team's
 * Google Sheet ("IDLS - Business DashBoard - Accounts and Sales", tab `Inflow`),
 * NOT TagMango. TagMango answers "what does this person have access to";
 * this ledger answers "what did we actually collect".
 *
 * The sheet's own `New Sale Tagging` column is the sale counter. The accounts
 * team has already deduplicated instalments against first payments — we never
 * attempt our own deduplication.
 */
import { LEDGER_REBUILD_PHRASE } from "./ledger-confirm";
import { getPg, pgRpc, pgSelect, pgUpsert, type PgClient } from "./pg.server";
import { analyzeAfterWrite } from "./load-guard.server";
import { raiseReviewItem } from "./review.server";


const DEFAULT_SHEET_ID = "1CiCXNXpiLXC__vzEulm-W8wPfOhDyzv0IXeK4AJpykk";
const DEFAULT_TAB = "Inflow";

/** Sheet columns we care about, matched on the FIRST LINE of the header cell. */
const HEADERS = {
  date: "Date of Inflow",
  payer: "Received From",
  email: "Email ID",
  source: "Source of Student",
  product: "Product",
  amount: "Amount Received",
  pending: "Amount Pending",
  rail: "Source of Receipt",
  paymentType: "Type Of Payment",
  saleType: "Sale Type",
  newSale: "New Sale Tagging",
} as const;

export type ReconciliationCheck = {
  label: string;
  expected: number | string;
  actual: number | string;
  ok: boolean;
};

export type LedgerSwapSummary = {
  previous_rows: number;
  new_rows: number;
  previous_amount: number;
  new_amount: number;
};

export type LedgerSyncResult = {
  status: "ok" | "error";
  rowsRead: number;
  rowsWritten: number;
  nextRow: number | null;
  hasMore: boolean;
  headerRow?: number;
  /** Present only on the pass that replaced the live table after a full re-import. */
  swap?: LedgerSwapSummary;
  reconciliation?: ReconciliationCheck[];
  error?: string;
};


function firstLine(s: string): string {
  return String(s ?? "").split("\n")[0]!.trim();
}

function norm(s: string): string {
  return firstLine(s).toLowerCase().replace(/\s+/g, " ");
}

/** Google serial date (days since 1899-12-30) or a text date → ISO yyyy-mm-dd. */
export function parseSheetDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = Math.round((raw - 25569) * 86400000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  const text = String(raw).trim();
  const dmy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y!.length === 2 ? `20${y}` : y!;
    return `${year}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

export function parseAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** `L1 - Silver Membership` → `L1_SILVER`. Everything else keeps its own tier. */
export function productTier(raw: string): string | null {
  const t = firstLine(raw);
  if (!t) return null;
  const upper = t.toUpperCase();
  if (upper.startsWith("L1")) return "L1_SILVER";
  if (upper.startsWith("L2")) return "L2";
  if (upper.startsWith("L3")) return "L3_DIAMOND";
  if (upper.startsWith("L4")) return "L4";
  return "OTHER";
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Shared with the team source register — see google-sheets.server.ts. */
async function sheetsGet(path: string, params: Record<string, string>): Promise<unknown> {
  const { sheetsGet: shared } = await import("./google-sheets.server");
  return shared(path, params);
}



async function setting(pg: PgClient, key: string, fallback: string): Promise<string> {
  const rows = await pgSelect<{ value: string | null }[]>(
    pg,
    `/app_settings?key=eq.${encodeURIComponent(key)}&select=value`,
  );
  const value = rows[0]?.value;
  return value && value.trim() !== "" ? value.trim() : fallback;
}

async function writeSetting(pg: PgClient, key: string, value: string, description: string) {
  await pgUpsert(pg, "app_settings", {
    key,
    value,
    description,
    updated_at: new Date().toISOString(),
  });
}

type Rows = (string | number | null)[][];

async function fetchRange(
  sheetId: string,
  tab: string,
  a1: string,
): Promise<Rows> {
  const json = (await sheetsGet(`/spreadsheets/${sheetId}/values/${tab}!${a1}`, {
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
    majorDimension: "ROWS",
  })) as { values?: Rows };
  return json.values ?? [];
}

/** Locate the header row and map our column names to indexes. */
async function resolveHeader(sheetId: string, tab: string) {
  const probe = await fetchRange(sheetId, tab, "A1:AZ20");
  const wanted = Object.values(HEADERS).map(norm);
  for (let i = 0; i < probe.length; i += 1) {
    const cells = (probe[i] ?? []).map((c) => norm(String(c ?? "")));
    const hits = wanted.filter((w) => cells.includes(w)).length;
    if (hits >= 6) {
      const index = (name: string) => {
        const at = cells.indexOf(norm(name));
        return at === -1 ? null : at;
      };
      return {
        headerRow: i + 1,
        cols: {
          date: index(HEADERS.date),
          payer: index(HEADERS.payer),
          email: index(HEADERS.email),
          source: index(HEADERS.source),
          product: index(HEADERS.product),
          amount: index(HEADERS.amount),
          pending: index(HEADERS.pending),
          rail: index(HEADERS.rail),
          paymentType: index(HEADERS.paymentType),
          saleType: index(HEADERS.saleType),
          newSale: index(HEADERS.newSale),
        },
      };
    }
  }
  throw new Error(
    `Could not find the ledger header row in tab "${tab}" — expected a row containing "Date of Inflow" and "New Sale Tagging".`,
  );
}

const CHUNK = 4000;
const BATCH = 500;
const CURSOR_KEY = "ledger_sync_cursor";
const HEADER_KEY = "ledger_header_row";
/**
 * Set while a full re-import is walking the sheet. While it is on, every row
 * read goes into a holding table and the live money table is left alone. It is
 * cleared only by a successful swap, or by an explicit abandon.
 */
const REBUILD_KEY = "ledger_rebuild_active";

export { LEDGER_REBUILD_PHRASE } from "./ledger-confirm";

/** Accounts backdate entries, so a routine run re-reads the trailing 60 days. */
const REPULL_DAYS = 60;


async function rewindRow(pg: PgClient, firstDataRow: number): Promise<number> {
  const cutoff = new Date(Date.now() - REPULL_DAYS * 86400000).toISOString().slice(0, 10);
  const rows = await pgSelect<{ sheet_row: number | null }[]>(
    pg,
    `/ledger_inflow?payment_date=gte.${cutoff}&select=sheet_row&order=sheet_row.asc&limit=1`,
  );
  const row = rows[0]?.sheet_row;
  return row && row > firstDataRow ? row : firstDataRow;
}

export type LedgerSyncOptions = {
  /**
   * Full re-import. Loads the whole sheet into a holding table and swaps it in
   * only once every row has been read successfully. Requires `confirm`.
   */
  restart?: boolean;
  chunks?: number;
  refresh?: boolean;
  /** Must equal LEDGER_REBUILD_PHRASE for `restart` to be honoured. */
  confirm?: string;
  /** Overrides the guard that refuses a swap losing more than 3% of the ledger. */
  allowShrink?: boolean;
};

/**
 * Imports the Inflow tab. Resumable: each call reads `chunks` blocks of rows and
 * stores the next row in app_settings, so a long sheet can be walked across
 * several requests without ever timing out.
 *
 * Registers the run BEFORE the first external call, so a sync that dies on a
 * Google Sheets error can never leave the ledger feed reading healthy.
 */
export async function runLedgerSync(options: LedgerSyncOptions = {}): Promise<LedgerSyncResult> {
  const pg = getPg();
  if (!pg) throw new Error("Database is not configured");

  // Refused before the run is even registered: a full re-import is the only
  // operation in the app that can lose money rows, so it needs the phrase.
  if (options.restart && options.confirm !== LEDGER_REBUILD_PHRASE) {
    throw new Error(
      `A full re-import replaces the whole collections ledger. To run it, type "${LEDGER_REBUILD_PHRASE}" to confirm.`,
    );
  }


  const started = await fetch(`${pg.url}/rest/v1/sync_runs`, {
    method: "POST",
    headers: {
      apikey: pg.key,
      Authorization: `Bearer ${pg.key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      source: "ledger",
      started_at: new Date().toISOString(),
      status: "running",
    }),
  });
  const runRow = started.ok ? ((await started.json()) as { id?: string }[]) : [];
  const runId = runRow?.[0]?.id ?? null;

  const patch = async (payload: Record<string, unknown>) => {
    if (!runId) return;
    await fetch(`${pg.url}/rest/v1/sync_runs?id=eq.${runId}`, {
      method: "PATCH",
      headers: {
        apikey: pg.key,
        Authorization: `Bearer ${pg.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  };

  try {
    const result = await runLedgerSyncInner(options, patch);
    // The Sources screen reads stored attribution, so it is refreshed once the
    // sheet has been walked to the end. Never fatal: a failed refresh leaves
    // yesterday's answer standing rather than breaking the money sync.
    if (!result.hasMore) {
      const { refreshSourcePrecompute } = await import("./source-precompute.server");
      await refreshSourcePrecompute();
    }
    return result;
  } catch (e) {
    const { safeMessage, rawDetail } = await import("./safe-error");
    // The verbatim text is captured FIRST, before the clean-up below can throw
    // its own error over the top of it. Losing it is how a failure becomes
    // undiagnosable (14 Sep: status 'error', error 'other', no detail).
    const detail = rawDetail(e, 1000);
    const kind = safeMessage(e, "ledger");
    // Abandon any half-finished re-import: clear the holding table and the
    // flag, so the next ordinary run writes to the live table as usual and a
    // partial read can never be mistaken for a complete one.
    try {
      if ((await setting(pg, REBUILD_KEY, "0")) === "1") {
        await pgRpc<null>(pg, "begin_ledger_rebuild", {});
        await writeSetting(pg, REBUILD_KEY, "0", "A full ledger re-import is in progress");
      }
    } catch {
      /* the original failure is the one worth reporting */
    }
    // The reconciliation is the alarm for "sales suddenly moved". It runs on
    // the failure path too, because that is exactly when it matters most.
    const reconciliation = await safeReconcile(pg);
    await patch({
      finished_at: new Date().toISOString(),
      status: "error",
      error: kind,
      error_detail: detail,
    });
    const failed = new Error(kind) as Error & {

      reconciliation?: ReconciliationCheck[];
    };
    if (reconciliation) failed.reconciliation = reconciliation;
    throw failed;
  }
}


async function runLedgerSyncInner(
  options: LedgerSyncOptions,
  patch: (payload: Record<string, unknown>) => Promise<void>,
): Promise<LedgerSyncResult> {
  const pg = getPg();
  if (!pg) throw new Error("Database is not configured");

  const sheetId = await setting(pg, "ledger_sheet_id", DEFAULT_SHEET_ID);
  const tab = await setting(pg, "ledger_tab", DEFAULT_TAB);

  const { headerRow, cols } = await resolveHeader(sheetId, tab);
  await writeSetting(pg, HEADER_KEY, String(headerRow), "Header row of the Inflow tab");

  const firstDataRow = headerRow + 1;
  let cursor = options.restart
    ? firstDataRow
    : Number(await setting(pg, CURSOR_KEY, String(firstDataRow)));
  if (!Number.isFinite(cursor) || cursor < firstDataRow) cursor = firstDataRow;

  if (!options.restart && options.refresh) {
    cursor = await rewindRow(pg, firstDataRow);
  }

  if (options.restart) {
    // NOTHING is deleted here. The whole sheet is read into a holding table
    // first; the live money table is only replaced once the last row has
    // arrived and the swap has passed its size check. A sheet error part-way
    // through therefore costs nothing but the run.
    await pgRpc<null>(pg, "begin_ledger_rebuild", {});
    await writeSetting(pg, REBUILD_KEY, "1", "A full ledger re-import is in progress");
  }

  // A re-import started on an earlier pass keeps writing to the holding table.
  const rebuilding = options.restart || (await setting(pg, REBUILD_KEY, "0")) === "1";


  const maxChunks = Math.max(1, Math.min(options.chunks ?? 20, 20));
  let rowsRead = 0;
  let rowsWritten = 0;
  let hasMore = true;
  /** Per-key occurrence counter keeps genuinely duplicated rows distinct. */
  const seen = new Map<string, number>();

  /**
   * Outstanding-amount quarantine.
   *
   * A single sheet row carrying an outstanding balance of minus seven crore is
   * enough to make every all-tier outstanding figure in the app negative. The
   * received amount on such a row is usually fine, so the row is kept and only
   * the outstanding value is dropped — and the owner is told which row to have
   * the accounts team correct. Values down to a hundred rupees below zero are
   * rounding noise from the sheet and are left alone.
   */
  const PENDING_FLOOR = -100;
  const PENDING_CEILING = 50_000_000;
  const quarantined: { sheetRow: number; payer: string; date: string | null; value: number }[] = [];
  const cleanPending = (value: number | null, sheetRow: number, payer: string, date: string | null) => {
    if (value === null) return null;
    if (value >= PENDING_FLOOR && value <= PENDING_CEILING) return value;
    quarantined.push({ sheetRow, payer, date, value });
    return null;
  };


  for (let c = 0; c < maxChunks; c += 1) {
    const end = cursor + CHUNK - 1;
    const values = await fetchRange(sheetId, tab, `A${cursor}:AZ${end}`);
    if (values.length === 0) {
      hasMore = false;
      break;
    }

    const payload: Record<string, unknown>[] = [];
    for (let i = 0; i < values.length; i += 1) {
      const row = values[i] ?? [];
      const sheetRow = cursor + i;
      const at = (idx: number | null) => (idx === null ? null : (row[idx] ?? null));

      const date = parseSheetDate(at(cols.date));
      const productRaw = firstLine(String(at(cols.product) ?? ""));
      const amount = parseAmount(at(cols.amount));
      if (!date && !productRaw && amount === null) continue; // blank spacer row

      const emailRaw = String(at(cols.email) ?? "").trim();
      const rail = firstLine(String(at(cols.rail) ?? ""));
      const key = [date ?? "", emailRaw.toLowerCase(), productRaw, amount ?? "", rail].join("|");
      const occurrence = (seen.get(key) ?? 0) + 1;
      seen.set(key, occurrence);

      payload.push({
        row_hash: await sha256(`${key}|${occurrence}`),
        payment_date: date,
        payer_name: String(at(cols.payer) ?? "").trim(),
        email_raw: emailRaw,
        source_of_student_raw: String(at(cols.source) ?? "").trim(),
        product_raw: productRaw,
        product_tier: productTier(productRaw),
        amount_received: amount ?? 0,
        amount_pending: cleanPending(
          parseAmount(at(cols.pending)),
          sheetRow,
          String(at(cols.payer) ?? "").trim(),
          date,
        ),
        receipt_source: rail,
        payment_type: firstLine(String(at(cols.paymentType) ?? "")),
        sale_type: firstLine(String(at(cols.saleType) ?? "")),
        is_new_sale: parseAmount(at(cols.newSale)) === 1,
        sheet_row: sheetRow,
      });
    }

    rowsRead += values.length;
    for (let i = 0; i < payload.length; i += BATCH) {
      const written = await pgRpc<number>(pg, rebuilding ? "stage_ledger_inflow" : "upsert_ledger_inflow", {
        p_rows: payload.slice(i, i + BATCH),
      });
      rowsWritten += Number(written ?? 0);
    }

    cursor += values.length;
    await writeSetting(pg, CURSOR_KEY, String(cursor), "Next Inflow row to import");

    if (values.length < CHUNK) {
      hasMore = false;
      break;
    }
  }

  // The swap. One statement in the database: it counts the holding table
  // against the live one, refuses a drop of more than 3% unless overridden,
  // and only then replaces the rows. If it refuses, the live ledger is
  // untouched and the holding table is kept for inspection.
  let swap: LedgerSwapSummary | undefined;
  if (rebuilding && !hasMore) {
    const raw = await pgRpc<Partial<LedgerSwapSummary>>(pg, "commit_ledger_rebuild", {
      p_allow_shrink: options.allowShrink ?? false,
    });
    swap = {
      previous_rows: Number(raw?.previous_rows ?? 0),
      new_rows: Number(raw?.new_rows ?? 0),
      previous_amount: Number(raw?.previous_amount ?? 0),
      new_amount: Number(raw?.new_amount ?? 0),
    };
    await writeSetting(pg, REBUILD_KEY, "0", "A full ledger re-import is in progress");
  }

  // A quarantined outstanding amount is an accounts-team correction, not
  // something the app can fix: the sheet is the source, so a database edit
  // would be overwritten on the next import. Name the row and ask for it.
  if (quarantined.length > 0) {
    const worst = quarantined.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a));
    await raiseReviewItem(pg, {
      kind: "owner_action",
      refId: "ledger_pending_out_of_range",
      title: `${quarantined.length} ledger row${quarantined.length === 1 ? "" : "s"} carry an impossible outstanding amount`,
      detail:
        `The outstanding balance on ${quarantined.length === 1 ? "this row" : "these rows"} is outside anything the business can owe, so it has been left blank rather than added into the outstanding totals. The money received on the row is unchanged. Please ask the accounts team to correct the sheet. Worst: row ${worst.sheetRow}` +
        `${worst.payer ? `, ${worst.payer}` : ""}${worst.date ? `, ${worst.date}` : ""}, showing ${Math.round(worst.value).toLocaleString("en-IN")}.`,
      evidence: { rows: quarantined.slice(0, 20) },
    });
  }

  await writeSetting(
    pg,
    "ledger_last_sync",
    new Date().toISOString(),
    "Last successful ledger import",
  );

  // Reconciliation runs whenever the live table has just changed — including
  // the pass that ends a re-import. It is the alarm that shouts if the sales
  // count moved, so it must never be the thing that gets skipped.
  const reconciliation = hasMore && !swap ? undefined : await safeReconcile(pg);

  await patch({
    finished_at: new Date().toISOString(),
    rows_written: rowsWritten,
    status: "ok",
  });

  return {
    status: "ok",
    rowsRead,
    rowsWritten,
    nextRow: hasMore ? cursor : null,
    hasMore,
    headerRow,
    ...(swap ? { swap } : {}),
    ...(reconciliation ? { reconciliation } : {}),
  };
}

/** Reconciliation must never be the reason a sync reports failure. */
async function safeReconcile(pg: PgClient): Promise<ReconciliationCheck[] | undefined> {
  try {
    return await reconcileLedger(pg);
  } catch {
    return [
      {
        label: "Reconciliation could not run",
        expected: "a comparison against the sheet",
        actual: "the check did not answer",
        ok: false,
      },
    ];
  }
}



/**
 * Reconciliation baseline.
 *
 * Only CLOSED months are asserted for equality — the accounts team keeps adding
 * rows to the running month, so an equality check there is guaranteed to cry
 * wolf. The open month is instead checked for monotonicity: it may grow, but a
 * drop means rows were deleted or the import broke.
 *
 * The baseline lives in `app_settings` (`ledger_baseline_monthly`) so it can be
 * corrected without a code change; the constant below is only the initial seed.
 */
const BASELINE_KEY = "ledger_baseline_monthly";
const HIGHWATER_KEY = "ledger_open_month_highwater";

const SEED_BASELINE: Record<string, number> = {
  "2026-01": 151,
  "2026-02": 137,
  "2026-03": 355,
  "2026-04": 302,
  "2026-05": 258,
  "2026-06": 283,
  "2026-07": 248,
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Current business month in Asia/Kolkata (day starts 06:00 IST). */
function currentBusinessMonth(): string {
  const shifted = new Date(Date.now() + 5.5 * 3600000 - 6 * 3600000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

export async function reconcileLedger(pg: PgClient): Promise<ReconciliationCheck[]> {
  const rawBaseline = await setting(pg, BASELINE_KEY, JSON.stringify(SEED_BASELINE));
  let baseline: Record<string, number>;
  try {
    baseline = JSON.parse(rawBaseline) as Record<string, number>;
  } catch {
    baseline = SEED_BASELINE;
  }
  await writeSetting(
    pg,
    BASELINE_KEY,
    JSON.stringify(baseline),
    "Expected L1 new-sale counts per CLOSED month (yyyy-mm → count). Edit here, not in code.",
  );

  const openMonth = currentBusinessMonth();
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const years = [...new Set([...Object.keys(baseline), openMonth].map((k) => Number(k.slice(0, 4))))];

  const monthlyActual: Record<string, number> = {};
  let openRows = 0;
  for (const year of years) {
    const got = await pgRpc<{ monthly: Record<string, number>; rows: number }>(
      pg,
      "ledger_reconciliation",
      { p_year: year, p_tier: "L1_SILVER", p_end: today },
    );
    openRows += Number(got.rows ?? 0);
    for (const [name, n] of Object.entries(got.monthly ?? {})) {
      const idx = MONTHS.indexOf(name as (typeof MONTHS)[number]);
      if (idx === -1) continue;
      monthlyActual[`${year}-${String(idx + 1).padStart(2, "0")}`] = Number(n);
    }
  }

  const checks: ReconciliationCheck[] = [];
  const asserted: string[] = [];
  const failures: string[] = [];

  for (const key of Object.keys(baseline).sort()) {
    if (key >= openMonth) continue; // open or future month: never asserted for equality
    const expected = Number(baseline[key]);
    const actual = monthlyActual[key] ?? 0;
    const ok = expected === actual;
    asserted.push(key);
    checks.push({ label: `New sales ${monthLabel(key)} (closed)`, expected, actual, ok });
    if (!ok) {
      const delta = actual - expected;
      failures.push(
        `${monthLabel(key)}: ${actual} vs expected ${expected} (${delta > 0 ? "+" : ""}${delta})`,
      );
    }
  }

  // Open month: monotonic non-decreasing against the previous run's high-water mark.
  const openActual = monthlyActual[openMonth] ?? 0;
  const rawHigh = await setting(pg, HIGHWATER_KEY, "{}");
  let high: Record<string, number> = {};
  try {
    high = JSON.parse(rawHigh) as Record<string, number>;
  } catch {
    high = {};
  }
  const previous = Number(high[openMonth] ?? 0);
  const openOk = openActual >= previous;
  checks.push({
    label: `New sales ${monthLabel(openMonth)} (open — must not fall)`,
    expected: `≥ ${previous}`,
    actual: openActual,
    ok: openOk,
  });
  if (!openOk) {
    failures.push(
      `${monthLabel(openMonth)}: ${openActual} vs ${previous} last run (${openActual - previous}) — sales went DOWN in the open month`,
    );
  }
  high[openMonth] = Math.max(previous, openActual);
  await writeSetting(
    pg,
    HIGHWATER_KEY,
    JSON.stringify(high),
    "Highest L1 new-sale count seen for the open month; the next run must not fall below it.",
  );

  const skipped = [openMonth, ...Object.keys(baseline).filter((k) => k > openMonth)];
  const scope = `Asserted closed months: ${asserted.map(monthLabel).join(", ") || "none"}. Skipped as open: ${skipped
    .map(monthLabel)
    .join(", ")}.`;

  await analyzeAfterWrite(pg, ["ledger_inflow", "tm_sales"]);

  await fetch(`${pg.url}/rest/v1/sync_runs`, {
    method: "POST",
    headers: {
      apikey: pg.key,
      Authorization: `Bearer ${pg.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "ledger-reconcile",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      rows_written: openRows,
      status: failures.length === 0 ? "ok" : "warning",
      error:
        failures.length === 0
          ? scope
          : `Ledger reconciliation mismatch — ${failures.join("; ")}. ${scope}`,
    }),
  });



  return checks;
}

