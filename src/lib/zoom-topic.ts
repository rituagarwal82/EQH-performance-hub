/**
 * Zoom topic normalisation.
 *
 * The team types the session topic by hand, so the same webinar arrives as
 * "Become the Energy Queen | Replay Session", "Replay-Session", "Replay- Session",
 * "REPLAY-SESSION", "|Replay-session", "Replay Session " and so on — at least a
 * dozen spellings. Dated live sessions arrive as "| 01-08-2026", "| 28-07-26",
 * "| 14th March 2026". Nothing here may guess: a topic that matches no rule is
 * 'unknown', never silently 'live'.
 *
 * The word lists and the replay offset live in app_settings.zoom_topic_rules so
 * the owner can edit them without a rebuild.
 */

export type TopicRules = {
  replay_words: string[];
  test_words: string[];
  date_patterns: string[];
  /** How many days before the replay the live session ran. */
  replay_offset_days: number;
};

export const DEFAULT_TOPIC_RULES: TopicRules = {
  replay_words: ["replay"],
  test_words: ["test", "testing", "dummy"],
  date_patterns: ["dd-mm-yyyy", "dd-mm-yy", "dd/mm/yyyy", "written"],
  replay_offset_days: 1,
};

export type SessionRole = "live" | "replay" | "test" | "unknown";

/** lowercase → strip punctuation → collapse whitespace. */
export function normaliseTopic(topic: string) {
  return (topic ?? "")
    .toLowerCase()
    .replace(/[|._\-–—/\\:,#()[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Pull a date out of the raw topic. Handles dd-mm-yyyy, dd-mm-yy, dd/mm/yyyy
 * and written forms ("14th March 2026", "14 Mar 2026"). Two-digit years are
 * read as 20xx. Returns null when the topic carries no date.
 */
export function parseTopicDate(topic: string): string | null {
  const raw = (topic ?? "").toLowerCase();

  const numeric = raw.match(/(\b[0-3]?\d)[-/.\s]([01]?\d)[-/.\s](\d{4}|\d{2})\b/);
  if (numeric) {
    const d = Number(numeric[1]);
    const m = Number(numeric[2]);
    const yRaw = Number(numeric[3]);
    const y = String(numeric[3]).length === 2 ? 2000 + yRaw : yRaw;
    const hit = iso(y, m, d);
    if (hit) return hit;
  }

  const written = raw.match(
    /\b([0-3]?\d)(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?\s+(\d{4}|\d{2})\b/,
  );
  if (written) {
    const d = Number(written[1]);
    const m = MONTHS[(written[2] ?? "").slice(0, 4)] ?? MONTHS[(written[2] ?? "").slice(0, 3)];
    const yRaw = Number(written[3]);
    const y = String(written[3]).length === 2 ? 2000 + yRaw : yRaw;
    if (m) {
      const hit = iso(y, m, d);
      if (hit) return hit;
    }
  }
  return null;
}

export function classifyTopic(
  topic: string,
  rules: TopicRules = DEFAULT_TOPIC_RULES,
): { role: SessionRole; topicDate: string | null; normalised: string } {
  const normalised = normaliseTopic(topic);
  const words = new Set(normalised.split(" "));
  const has = (list: string[]) => list.some((w) => words.has(w.toLowerCase()));

  const topicDate = parseTopicDate(topic);
  let role: SessionRole = "unknown";
  if (has(rules.test_words ?? [])) role = "test";
  else if (has(rules.replay_words ?? [])) role = "replay";
  else if (topicDate) role = "live";

  return { role, topicDate, normalised };
}

/** 06:00–05:59 IST business day, matching public.business_date in Postgres. */
export function businessDate(startTime: string): string | null {
  const t = Date.parse(startTime);
  if (!Number.isFinite(t)) return null;
  // shift into IST, then back off the 06:00 boundary
  return new Date(t + 5.5 * 3600_000 - 6 * 3600_000).toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number) {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return new Date(t + days * 86400_000).toISOString().slice(0, 10);
}

/**
 * The logical event a session belongs to: the business day the LIVE session
 * ran. A replay is keyed to the live it replays (one day earlier by default),
 * so live + replay collapse into a single funnel event while both rows stay
 * visible in detail.
 */
export function eventKeyFor(
  role: SessionRole,
  topicDate: string | null,
  startTime: string,
  rules: TopicRules = DEFAULT_TOPIC_RULES,
): string | null {
  const bday = businessDate(startTime);
  if (role === "live") return topicDate ?? bday;
  if (role === "replay") {
    if (topicDate) return topicDate;
    return bday ? addDays(bday, -(rules.replay_offset_days ?? 1)) : null;
  }
  if (role === "test") return null;
  return topicDate ?? bday;
}
