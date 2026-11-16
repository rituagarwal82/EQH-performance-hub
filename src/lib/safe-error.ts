/**
 * P0-B — one door for caught errors.
 *
 * House rule, owner-set 7 Sep after a 57014 JSON payload appeared on a
 * decision screen: nothing a driver, an HTTP client or a third-party API says
 * is ever carried to the browser. A server function returns a KIND TOKEN
 * ("timeout" | "unavailable" | "other"); the UI turns that into one plain
 * sentence, and the verbatim text is logged where an engineer will find it.
 */

export type ErrorKind = "timeout" | "unavailable" | "other";

const TIMEOUTISH = [
  "57014",
  "statement timeout",
  "canceling statement",
  "timeout",
  "timed out",
  "etimedout",
  "fetch failed",
  "econnreset",
];

const UNAVAILABLEISH = ["503", "504", "520", "521", "522", "524", "bad gateway", "unavailable"];

/**
 * B2, owner-set 11 Sep: a kind token alone cost four days on one failure that
 * read only "other". The verbatim text is kept here, in memory, so the job that
 * is failing can store it on its own run row for diagnosis. It is NEVER put on
 * a screen — the owner-facing copy still comes from the kind token.
 */
let lastRaw: string | null = null;

/** Raw text of the most recent caught error, truncated for storage. */
export function lastRawError(limit = 1000): string | null {
  return lastRaw ? lastRaw.slice(0, limit) : null;
}

/** Raw text of a specific error, truncated for storage. Never for the UI. */
export function rawDetail(e: unknown, limit = 1000): string {
  // A database error carries the driver body on `raw`; its own message is only
  // the kind token, which is exactly the detail this function must not lose.
  const carried = (e as { raw?: unknown } | null)?.raw;
  if (typeof carried === "string" && carried) return carried.slice(0, limit);
  const raw =
    e instanceof Error
      ? `${e.name}: ${e.message}`
      : typeof e === "string"
        ? e
        : (() => {
            try {
              return JSON.stringify(e);
            } catch {
              return String(e);
            }
          })();
  return raw.slice(0, limit);
}

/** Never returns anything but a kind token. Logs the verbatim text. */
export function safeMessage(e: unknown, where = "server"): ErrorKind {
  const raw = rawDetail(e, 4000);
  lastRaw = `${where}: ${raw}`.slice(0, 1000);
  if (typeof console !== "undefined") console.error(`[EQH] ${where}:`, raw);
  if (raw === "timeout" || raw === "unavailable" || raw === "other") return raw;
  const t = raw.toLowerCase();
  if (TIMEOUTISH.some((k) => t.includes(k))) return "timeout";
  if (UNAVAILABLEISH.some((k) => t.includes(k))) return "unavailable";
  return "other";
}
