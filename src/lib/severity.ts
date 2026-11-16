/**
 * THREE TIERS, AND ONLY THREE.
 *
 * The owner opened the dashboard and read a screen full of known, expected
 * states as errors. That is a presentation fault, not a data fault: severity
 * has to be legible at a glance, or every state reads as alarm.
 *
 *   red   — a real disagreement that needs someone to act today.
 *   amber — watching, recalibrating, or the aftermath of a finished job. Always
 *           carries a plain sentence saying when it clears by itself.
 *   info  — a known structural fact about how the sources differ. Never styled
 *           as an error, never uses the word "error".
 *   ok    — nothing to say.
 */

export type Tier = "red" | "amber" | "info" | "ok";

export const TIER_CHIP: Record<Tier, string> = {
  red: "bg-destructive/15 text-destructive",
  amber: "bg-warning/15 text-warning",
  info: "bg-muted text-muted-foreground",
  ok: "bg-positive/15 text-positive",
};

export const TIER_NOTE: Record<Tier, string> = {
  red: "text-destructive",
  amber: "text-warning",
  info: "text-muted-foreground/80",
  ok: "text-muted-foreground",
};

export const TIER_PANEL: Record<Tier, string> = {
  red: "border-destructive/40 bg-destructive/10 text-destructive",
  amber: "border-warning/40 bg-warning/10 text-warning",
  info: "border-border bg-muted/40 text-muted-foreground",
  ok: "border-border bg-card text-muted-foreground",
};

export const TIER_RANK: Record<Tier, number> = { red: 0, amber: 1, info: 2, ok: 3 };

/**
 * Feed messages that are notes about how the world is, not faults. They are
 * rewritten into plain footnotes rather than printed as a raw last_error.
 */
function informationalFeedNote(feed: string, raw: string): string | null {
  if (/no Zoom Webinar licence/i.test(raw)) {
    const n = (raw.match(/no Zoom Webinar licence/gi) ?? []).length;
    return `${n} secondary Zoom account${n === 1 ? "" : "s"} don't host webinars — expected, and nothing is missing because of it.`;
  }
  if (/Asserted closed months/i.test(raw)) {
    return raw.replace(/^.*?Asserted closed months/i, "Closed months re-checked and unchanged");
  }
  if (feed === "ledger" && /Skipped as open/i.test(raw)) return raw;
  return null;
}

export type FeedLike = {
  feed: string;
  status: string;
  is_blocking: boolean;
  last_error: string | null;
  hours_since_success: number | string | null;
};

/**
 * One feed, one tier, one sentence. A finished one-off import must not keep a
 * feed looking alarming once the steady-state runs are succeeding, so the note
 * always states how it resolves.
 */
/**
 * When a feed has stopped, the chip and the note must say the SAME plain thing
 * and name the action. A thin-yield warning from the last run is not allowed to
 * contradict a stopped feed.
 */
export function brokenAction(feed: string): string | null {
  if (feed === "recordings") {
    return "Zoom has saved no webinar recording since 6 September even though webinars have run. Cloud recording is switched off in Zoom — someone must switch it back on. Nothing is broken on our side.";
  }
  return null;
}

export function feedSeverity(feed: FeedLike): { tier: Tier; note: string | null } {
  const raw = feed.last_error?.trim() || null;
  const info = raw ? informationalFeedNote(feed.feed, raw) : null;

  if (feed.status === "broken") {
    return {
      tier: "red",
      note:
        brokenAction(feed.feed) ??
        raw ??
        "This feed has stopped collecting and the numbers behind it will not move.",
    };
  }
  if (feed.status === "late" || feed.status === "stale") {
    return {
      tier: "amber",
      note:
        info ??
        raw ??
        "Behind its usual cadence. It clears itself on the next successful run; nothing is wrong with what is already collected.",
    };
  }
  // Live. A message on a live feed is a footnote, never an error — unless it is
  // something we do not recognise, which stays amber so it is not swallowed.
  if (!raw) return { tier: "ok", note: null };
  return info ? { tier: "info", note: info } : { tier: "amber", note: raw };
}

export type ProofLike = {
  status: string;
  enabled?: boolean | null;
  needs_recalibration?: boolean | null;
  diverged: number;
  structural_note?: string | null;
};

/** A check's tier: red only when it is calibrated, ran, and disagreed. */
export function proofSeverity(check: ProofLike): Tier {
  if (check.enabled === false) return "info";
  if (check.needs_recalibration) return "amber";
  if (check.status === "diverged" && check.diverged > 0) return "red";
  if (check.status === "stale" || check.status === "never_run") return "amber";
  if (check.status === "unverified") return "info";
  return "ok";
}
