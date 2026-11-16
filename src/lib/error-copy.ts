/**
 * ERROR COPY.
 *
 * House rule, owner-set 7 Sep after a raw driver payload appeared on screen:
 * the owner never reads a database or driver message. Everything a caught
 * error carries is technical, and technical text on a decision screen reads as
 * breakage even when the fix is already in hand.
 *
 * So: one human sentence in the UI, the verbatim detail to the console and to
 * Feed Health, which is the screen built to hold it.
 */

import { useEffect } from "react";

const TIMEOUTISH = [
  "57014",
  "statement timeout",
  "timeout",
  "timed out",
  "canceling statement",
  "connection",
  "fetch failed",
  "econnreset",
  " 520",
  " 521",
  " 522",
  " 524",
];

export function isSlowDatabase(detail?: string | null): boolean {
  if (!detail) return false;
  const m = detail.toLowerCase();
  return TIMEOUTISH.some((t) => m.includes(t));
}

/**
 * The one sentence the owner sees. `subject` names what could not be read, in
 * the owner's own words — "the figures", "the queue", "the checks".
 */
export function humanError(detail?: string | null, subject = "the figures"): string {
  if (isSlowDatabase(detail)) {
    return `The engine could not read ${subject} — paused, nothing is lost. It retries by itself.`;
  }
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} could not be read just now — nothing is lost, and the technical detail is on Feed Health.`;
}

/** Puts the verbatim detail where an engineer can find it, and nowhere else. */
export function useTechnicalDetail(where: string, detail?: string | null) {
  useEffect(() => {
    if (detail) console.error(`[EQH] ${where}:`, detail);
  }, [where, detail]);
}

/**
 * Client-side counterpart of safeMessage: whatever a mutation throws, this is
 * the only thing allowed into a toast or an inline message.
 *
 * A sentence our OWN code wrote ("Sync failed without an error message.") is
 * readable and passes through. Anything carrying driver shape — JSON, a status
 * code, a SQLSTATE, a stack — is replaced by the human sentence and logged.
 */
export function uiMessage(e: unknown, subject = "that action"): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  if (typeof console !== "undefined") console.error(`[EQH] ${subject}:`, e);
  const looksTechnical =
    !raw ||
    raw.length > 160 ||
    /[{}[\]]/.test(raw) ||
    /\b\d{3,5}\b/.test(raw) ||
    /error \(|sqlstate|pgrst|at .*\.tsx?:|https?:\/\//i.test(raw) ||
    raw === "timeout" ||
    raw === "unavailable" ||
    raw === "other";
  if (looksTechnical) return humanError(raw, subject);
  return raw;
}
