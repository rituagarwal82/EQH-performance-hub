/**
 * ONE DOOR TO GOOGLE SHEETS.
 *
 * Both sheet-backed sources (the accounts collections ledger and the team's
 * source register) read through this. Owner-set after 14 Sep: a sheet request
 * that fails must say WHY in words an engineer can act on — the status and the
 * provider's own body, verbatim — so a nightly failure is never a blank again.
 *
 * Transient answers (429 busy, 5xx) are waited out with a widening, jittered
 * gap rather than losing the whole nightly import to one busy minute.
 */

const GATEWAY = "https://connector-gateway.lovable.dev/google_sheets/v4";

const ATTEMPTS = 5;

export type SheetRows = (string | number | null)[][];

export async function sheetsGet(
  path: string,
  params: Record<string, string>,
): Promise<unknown> {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const connectionKey = process.env["GOOGLE_SHEETS_API_KEY"];
  if (!lovableKey) throw new Error("LOVABLE_API_KEY is not configured");
  if (!connectionKey) {
    throw new Error(
      "Google Sheets is not connected yet. The sheet cannot be imported until the spreadsheet is connected.",
    );
  }
  const qs = new URLSearchParams(params).toString();

  const { logRetry } = await import("./retry-log.server");

  let last = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${GATEWAY}${path}${qs ? `?${qs}` : ""}`, {
        headers: {
          Authorization: `Bearer ${lovableKey}`,
          "X-Connection-Api-Key": connectionKey,
        },
      });
    } catch (e) {
      // A dropped connection is transient too, and its text matters.
      last = `Google Sheets request failed (network): ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
      // A run that survives only because it retried must still be visible.
      await logRetry("google_sheets", path, attempt + 1, last);
      await wait(attempt);
      continue;
    }
    if (res.ok) return res.json();
    const body = await res.text();
    last = `Google Sheets request failed [${res.status}] ${path}: ${body.slice(0, 400)}`;
    if (res.status !== 429 && res.status < 500) throw new Error(last);
    await logRetry("google_sheets", path, attempt + 1, last);
    await wait(attempt);
  }
  throw new Error(`${last} (gave up after ${ATTEMPTS} attempts)`);
}

function wait(attempt: number) {
  const base = 2000 * 2 ** attempt;
  return new Promise((r) => setTimeout(r, base + Math.floor(Math.random() * 1000)));
}

/** Values of one A1 range, unformatted, dates as serial numbers. */
export async function fetchSheetRange(
  sheetId: string,
  tab: string,
  a1: string,
): Promise<SheetRows> {
  const json = (await sheetsGet(`/spreadsheets/${sheetId}/values/${tab}!${a1}`, {
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
    majorDimension: "ROWS",
  })) as { values?: SheetRows };
  return json.values ?? [];
}
