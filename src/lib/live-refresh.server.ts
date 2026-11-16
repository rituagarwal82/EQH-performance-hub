/**
 * ON-DEMAND FRESHNESS.
 *
 * An hourly import still leaves up to an hour of blindness, and the owner asks
 * about "today" constantly — on 22 Sep 2026 he had to paste his own TagMango
 * dashboard to correct an answer that reported one sale when there were nine.
 *
 * So any question whose window includes today pulls the two intraday feeds
 * first and then answers. The pull is deliberately small (the newest buyers
 * only, and one day of registrations), and a result is reused for a few
 * minutes so a run of questions never hammers the API.
 */

import { getPg, pgSelect, pgUpsert } from "./pg.server";

const CACHE_KEY = "live_refresh_last";
export const CACHE_MINUTES = 4;

export type LiveRefresh = {
  /** When the feeds were actually last pulled (ISO). */
  refreshedAt: string | null;
  /** True when this call did the pulling rather than reusing a recent one. */
  pulled: boolean;
  paymentsWritten: number | null;
  leadsWritten: number | null;
  notes: string[];
};

type Cached = {
  refreshedAt: string;
  paymentsWritten: number | null;
  leadsWritten: number | null;
  notes: string[];
};

/** Words that put a question's window on the current day. */
const TODAY_WORDS =
  /\b(today|today'?s|right now|just now|so far|this week|this month|current|currently|latest|live|at the moment|up to now|till now|until now)\b/i;

export function questionTouchesToday(question: string): boolean {
  return TODAY_WORDS.test(question);
}

async function readCache(): Promise<Cached | null> {
  const pg = getPg();
  if (!pg) return null;
  try {
    const rows = await pgSelect<{ value: string | null }[]>(
      pg,
      `/app_settings?select=value&key=eq.${CACHE_KEY}&limit=1`,
    );
    const raw = rows[0]?.value;
    if (!raw) return null;
    return JSON.parse(raw) as Cached;
  } catch {
    return null;
  }
}

async function writeCache(value: Cached): Promise<void> {
  const pg = getPg();
  if (!pg) return;
  try {
    await pgUpsert(pg, "app_settings", {
      key: CACHE_KEY,
      value: JSON.stringify(value),
      description:
        "Last on-demand refresh of the intraday feeds (course payments and registrations), used to answer questions about today.",
      updated_at: new Date().toISOString(),
    });
  } catch {
    /* a failed note must never stop the answer */
  }
}

/**
 * Pull the two intraday feeds for the current day. Reuses a pull from the last
 * few minutes. Never throws: a failed pull is reported in `notes` and the
 * caller answers from what is stored, saying how old it is.
 */
export async function refreshToday(options: { force?: boolean } = {}): Promise<LiveRefresh> {
  const cached = await readCache();
  if (!options.force && cached) {
    const ageMs = Date.now() - Date.parse(cached.refreshedAt);
    if (Number.isFinite(ageMs) && ageMs < CACHE_MINUTES * 60_000) {
      return {
        refreshedAt: cached.refreshedAt,
        pulled: false,
        paymentsWritten: cached.paymentsWritten,
        leadsWritten: cached.leadsWritten,
        notes: cached.notes,
      };
    }
  }

  const notes: string[] = [];
  let paymentsWritten: number | null = null;
  let leadsWritten: number | null = null;

  try {
    const { runTagMangoPaymentSync } = await import("./tagmango-payments.server");
    const result = await runTagMangoPaymentSync({ tailOnly: true });
    paymentsWritten = result.paymentsWritten;
    if (result.errors.length > 0) notes.push(`Course payments: ${result.errors[0]}`);
  } catch (e) {
    notes.push(
      `Course payments could not be refreshed just now: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    const { runGhlLeadSync } = await import("./ghl-sync.server");
    const result = await runGhlLeadSync({ days: 1, maxPages: 5, source: "ghl-live" });
    leadsWritten = result.rowsWritten ?? null;
    if (result.status === "error") notes.push("Registrations could not be refreshed just now.");
  } catch (e) {
    notes.push(
      `Registrations could not be refreshed just now: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const refreshedAt = new Date().toISOString();
  await writeCache({ refreshedAt, paymentsWritten, leadsWritten, notes });
  return { refreshedAt, pulled: true, paymentsWritten, leadsWritten, notes };
}

/** How the refresh reads in an answer, in IST. */
export function refreshLine(r: LiveRefresh): string {
  if (!r.refreshedAt) return "The live feeds could not be refreshed for this answer.";
  const at = new Date(r.refreshedAt).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const how = r.pulled ? "refreshed just now" : "refreshed a few minutes ago";
  const problems = r.notes.length > 0 ? ` (${r.notes.join("; ")})` : "";
  return `LIVE REFRESH: course payments and registrations were ${how}, at ${at} IST. State this time in the answer for anything about today.${problems}`;
}
