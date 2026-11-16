/**
 * Cross-source arbitration contract.
 *
 * Several numbers on this dashboard have more than one witness. This registry
 * states, per metric and in one place, WHICH source gets posted, which source
 * merely watches, how far apart the two may drift before that counts as a
 * disagreement, and what happens when they do drift.
 *
 * Three rules hold everywhere:
 *   - never silent   — every arbitrated number wears a mark showing its state
 *   - never averaged — a disagreement posts the precedence winner, not a blend
 *   - never flattering — precedence is fixed in advance, so the losing source
 *     cannot be preferred simply because it looks better today
 *
 * The registry is versioned. Changing a precedence or a tolerance is a change
 * to the contract and must move the version below.
 */

import type { ProofSummaryRow } from "./proof";

export const ARBITRATION_VERSION = "arb-1";

export type ArbitrationState = "agree" | "single" | "disagree" | "unchecked";

export type ArbitrationRule = {
  /** Metric id as used by the verdict engine / contract registry. */
  id: string;
  label: string;
  /** The proof check that compares the two witnesses, when one exists. */
  checkId: string | null;
  /** The source that gets posted, and the condition under which it wins. */
  primary: { source: string; when: string };
  /** The second reading. Either a pure witness, or a permitted fallback. */
  witness: { source: string; role: "witness" | "fallback" };
  /** Gap beyond which the two readings count as disagreeing. */
  tolerancePct: number;
  /** The rule in one plain sentence, shown to the owner on hover. */
  rule: string;
};

export const ARBITRATION_RULES: ArbitrationRule[] = [
  {
    id: "sales_count",
    label: "Sales count",
    checkId: "sales_count",
    primary: {
      source: "accounts ledger (New Sale Tagging)",
      when: "days that have settled (3 days old or more)",
    },
    witness: { source: "TagMango enrolments", role: "fallback" },
    tolerancePct: 20,
    rule: "Settled days are posted from the accounts ledger; the last three days are posted from TagMango enrolments because the ledger has not caught up yet. If the day's preferred source has not synced, the other one is posted and the number says so.",
  },
  {
    id: "collected",
    label: "Blended L1 cash",
    checkId: null,
    primary: { source: "accounts ledger", when: "always" },
    witness: { source: "TagMango payment amounts", role: "witness" },
    tolerancePct: 10,
    rule: "Money is always posted from the accounts ledger. TagMango amounts are watched but never posted — they miss offline and instalment rails.",
  },
  {
    id: "front_end_roas",
    label: "Paid front-end ROAS (ex-GST)",
    checkId: "attribution_purity",
    primary: { source: "accounts ledger ÷ Meta spend", when: "always" },
    witness: { source: "all L1 cash ÷ Meta spend", role: "witness" },
    tolerancePct: 5,
    rule: "Posted from ad-attributed new-sale cash ex-GST over Meta spend. All-cash is watched only: if the two come within 5% of each other, attribution coverage has collapsed and that is a warning, not good news.",
  },
  {
    id: "meta_spend",
    label: "Meta spend",
    checkId: "meta_spend",
    primary: { source: "Meta Ads API", when: "always" },
    witness: { source: "account-level re-pull", role: "witness" },
    tolerancePct: 2,
    rule: "Spend is always posted from the Meta API. No sheet or ledger figure is ever posted as spend; a second Meta pull at account level is the witness.",
  },
  {
    id: "registrations",
    label: "Registrations",
    checkId: "registrations",
    primary: { source: "lead records (GHL)", when: "always" },
    witness: { source: "Zoom registrants", role: "witness" },
    tolerancePct: 60,
    rule: "Registrations are posted from lead records. Zoom registrant counts are a witness only: one person registering for a session and its replay is counted twice by Zoom and once here, so a wide gap is expected and tolerance is deliberately loose.",
  },
  {
    id: "show_up_rate",
    label: "Show-up rate",
    checkId: "attendance_integrity",
    primary: { source: "Zoom participants (rejoins collapsed)", when: "always" },
    witness: { source: "lead tags", role: "witness" },
    tolerancePct: 10,
    rule: "Attendance is always posted from Zoom. Lead tags are a witness only — they are set by hand and drift.",
  },
];

export function ruleFor(id: string): ArbitrationRule | null {
  return ARBITRATION_RULES.find((r) => r.id === id) ?? null;
}

export type Arbitrated = {
  rule: ArbitrationRule;
  state: ArbitrationState;
  /** The source the posted number came from. */
  postedFrom: string;
  /** One calm sentence for the hover. */
  detail: string;
};

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(v: number | string | null | undefined): string {
  const n = num(v);
  if (n === null) return "no value";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/**
 * Resolve a metric's agreement state from its proof check. A check that never
 * ran is never rendered as agreement: absence shows as absence.
 */
export function arbitrate(rule: ArbitrationRule, check: ProofSummaryRow | null): Arbitrated {
  const posted = rule.primary.source;
  const both = (c: ProofSummaryRow) =>
    `${c.primary_source ?? posted} ${fmt(c.worst_primary)} · ${c.witness_source ?? rule.witness.source} ${fmt(c.worst_witness)}`;

  if (!rule.checkId || !check || check.status === "never_run" || check.status === "unverified") {
    return {
      rule,
      state: "single",
      postedFrom: posted,
      detail: `One source: ${posted}. ${rule.witness.source} is watched, not posted. ${rule.rule}`,
    };
  }
  if (check.status === "stale") {
    return {
      rule,
      state: "single",
      postedFrom: posted,
      detail: `Posted from ${posted}. The comparison against ${check.witness_source ?? rule.witness.source} has not run recently, so only one source stands behind this today. ${rule.rule}`,
    };
  }
  if (check.status === "diverged") {
    return {
      rule,
      state: "disagree",
      postedFrom: posted,
      detail: `Two sources disagree on ${check.diverged} of ${check.days_checked} day${check.days_checked === 1 ? "" : "s"} (widest ${check.worst_date ?? "recently"}: ${both(check)}). Posted from ${posted} by rule — never averaged. ${rule.rule}`,
    };
  }
  return {
    rule,
    state: "agree",
    postedFrom: posted,
    detail: `Two sources agree across ${check.days_checked} day${check.days_checked === 1 ? "" : "s"} (widest gap ${check.worst_date ?? "—"}: ${both(check)}). Posted from ${posted}. ${rule.rule}`,
  };
}
