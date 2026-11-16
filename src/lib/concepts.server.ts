/**
 * The concept ledger engine.
 *
 * A concept is a persona × pain × promise cell. Scripts are its iterations.
 * State moves only through a human decision: this file computes the numbers
 * that would justify a move and files them as review items. It never changes
 * a state on its own, never pauses an ad, and never moves budget.
 */

import {
  getPg,
  pgInsert,
  pgRpc,
  pgSelect,
  pgUpdate,
  pgUpsert,
  type PgClient,
} from "./pg.server";
import { raiseReviewItem } from "./review.server";
import { safeMessage } from "./safe-error";
import { plainConcept } from "./taxonomy";

/** Thresholds are constants here, not model judgement. */
export const RULES = {
  iterationSpend: 31000,
  attendanceMin: 0.35,
  provenLeads: 1000,
  fatigueMultiple: 1.3,
  fatigueSpendFlat: 0.25,
  fatigueFrequency: 2.5,
  fatigueRateDrop: 0.2,
  concurrencyMax: 6,
  medianWindowDays: 90,
} as const;

export type LedgerRow = {
  concept_id: string;
  name: string;
  persona: string;
  pain: string;
  promise: string;
  state: string;
  reference_cpl: number | string | null;
  opened_at: string;
  state_changed_at: string;
  iterations: number | string;
  ads_mapped: number | string;
  spend: number | string;
  matched_leads: number | string;
  matured_leads: number | string;
  attendees: number | string;
  attendees_60: number | string;
  matured_sales: number | string;
};

export type PersonaMedian = {
  persona: string;
  n_concepts: number | string;
  median_cpl: number | string | null;
  median_cost_60: number | string | null;
};

export type WeeklyStat = {
  concept_id: string;
  state: string;
  reference_cpl: number | string | null;
  spend_7d: number | string | null;
  leads_7d: number | string | null;
  cpl_7d: number | string | null;
  attendees_60_7d: number | string | null;
  rate_60_7d: number | string | null;
  spend_prev7: number | string | null;
  leads_prev7: number | string | null;
  cpl_prev7: number | string | null;
  rate_60_prev7: number | string | null;
  frequency_7d: number | string | null;
};

export type BalanceRow = {
  dimension: string;
  label: string;
  spend: number | string;
  share: number | string | null;
};

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export function medianFor(medians: PersonaMedian[], persona: string, field: "cpl" | "cost60") {
  const key = field === "cpl" ? "median_cpl" : "median_cost_60";
  const row = medians.find((m) => m.persona === persona);
  if (row && Number(row.n_concepts) >= 3 && n(row[key]) !== null) {
    return { value: n(row[key])!, basis: `${persona} median` };
  }
  const acct = medians.find((m) => m.persona === "(account)");
  const v = acct ? n(acct[key]) : null;
  return v === null ? null : { value: v, basis: "account median (persona has fewer than 3 concepts)" };
}

/** Next free K-nn identifier. */
async function nextConceptId(pg: PgClient): Promise<string> {
  const rows =
    (await pgSelect<{ concept_id: string }[]>(
      pg,
      "/concepts?select=concept_id&order=concept_id.desc&limit=1",
    )) ?? [];
  const last = rows[0]?.concept_id ?? "K-00";
  const num = Number(last.replace(/[^\d]/g, "")) || 0;
  return `K-${String(num + 1).padStart(2, "0")}`;
}

/** Open a concept from a confirmed proposal. Always starts in TESTING. */
export async function openConcept(
  pg: PgClient,
  cell: { persona: string; pain: string; promise: string; script_ids?: string[] },
): Promise<string> {
  const conceptId = await nextConceptId(pg);
  await pgUpsert(pg, "concepts", {
    concept_id: conceptId,
    name: plainConcept(cell.persona, cell.pain, cell.promise),
    persona: cell.persona,
    pain: cell.pain,
    promise: cell.promise,
    state: "TESTING",
  });
  for (const id of cell.script_ids ?? []) {
    await pgUpsert(pg, "concept_scripts", { concept_id: conceptId, script_id: id });
  }
  await pgInsert(pg, "concept_state_log", {
    concept_id: conceptId,
    from_state: null,
    to_state: "TESTING",
    reason: `Opened from a confirmed proposal with ${(cell.script_ids ?? []).length} iteration(s).`,
    evidence: cell,
    decided_by: "human",
  });
  return conceptId;
}

/** Apply a confirmed transition, recording the number that caused it. */
export async function applyTransition(
  pg: PgClient,
  conceptId: string,
  toState: string,
  reason: string,
  evidence: Record<string, unknown>,
  referenceCpl?: number | null,
) {
  const rows =
    (await pgSelect<{ state: string }[]>(
      pg,
      `/concepts?select=state&concept_id=eq.${encodeURIComponent(conceptId)}&limit=1`,
    )) ?? [];
  const from = rows[0]?.state ?? null;
  await pgUpdate(pg, "concepts", `concept_id=eq.${encodeURIComponent(conceptId)}`, {
    state: toState,
    state_changed_at: new Date().toISOString(),
    ...(referenceCpl !== undefined && referenceCpl !== null ? { reference_cpl: referenceCpl } : {}),
  });
  await pgInsert(pg, "concept_state_log", {
    concept_id: conceptId,
    from_state: from,
    to_state: toState,
    reason,
    evidence,
    decided_by: "human",
  });
}

export type ProposalReport = {
  status: "success" | "error";
  evaluated: number;
  proposed: number;
  notes: string[];
  error: string | null;
};

/**
 * The weekly pass. Reads the ledger, tests each rule, and files proposals.
 * Nothing here writes a state.
 */
export async function proposeTransitions(asof?: string | null): Promise<ProposalReport> {
  const pg = getPg();
  if (!pg) {
    return { status: "error", evaluated: 0, proposed: 0, notes: [], error: "Backend not configured." };
  }
  const end = asof ?? new Date().toISOString().slice(0, 10);
  const start = new Date(`${end}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - RULES.medianWindowDays);
  const since = start.toISOString().slice(0, 10);

  const notes: string[] = [];
  let proposed = 0;

  try {
    const prevWeek = new Date(`${end}T00:00:00Z`);
    prevWeek.setUTCDate(prevWeek.getUTCDate() - 7);
    const prevEnd = prevWeek.toISOString().slice(0, 10);

    const [ledger, medians, weekly, weeklyPrev, baseline, registry, links] = await Promise.all([
      pgRpc<LedgerRow[]>(pg, "concept_ledger", { p_start: since, p_end: end }),
      pgRpc<PersonaMedian[]>(pg, "persona_medians", { p_days: RULES.medianWindowDays }),
      pgRpc<WeeklyStat[]>(pg, "concept_weekly_stats", { p_end: end }),
      pgRpc<WeeklyStat[]>(pg, "concept_weekly_stats", { p_end: prevEnd }),
      pgRpc<{ matured_leads: number; matured_sales: number; sale_rate: number | null }[]>(
        pg,
        "account_matured_sale_rate",
        { p_start: since, p_end: end },
      ),
      pgRpc<{ script_id: string; script_code: string; spend: number | string; tracked_leads: number | string }[]>(
        pg,
        "creative_registry",
        { p_start: since, p_end: end },
      ),
      pgSelect<{ concept_id: string; script_id: string }[]>(
        pg,
        "/concept_scripts?select=concept_id,script_id&limit=2000",
      ),
    ]);

    const acctRate = n(baseline?.[0]?.sale_rate);
    const byConcept = new Map<string, string[]>();
    for (const l of links ?? []) {
      byConcept.set(l.concept_id, [...(byConcept.get(l.concept_id) ?? []), l.script_id]);
    }
    const regById = new Map((registry ?? []).map((r) => [r.script_id, r]));
    const weekById = new Map((weekly ?? []).map((w) => [w.concept_id, w]));
    const prevById = new Map((weeklyPrev ?? []).map((w) => [w.concept_id, w]));

    const live = (ledger ?? []).filter((c) => c.state === "TESTING" || c.state === "PROMISING");
    if (live.length > RULES.concurrencyMax) {
      await raiseReviewItem(pg, {
        kind: "concept_concurrency",
        refId: "concurrency",
        title: `${live.length} concepts are live at once — the working limit is ${RULES.concurrencyMax}`,
        detail:
          "Testing and promising concepts compete for the same learning budget. Retire or park one before opening another.",
        evidence: { live: live.map((c) => c.concept_id), limit: RULES.concurrencyMax },
      });
      proposed += 1;
    }

    for (const c of ledger ?? []) {
      const personaCpl = medianFor(medians ?? [], c.persona, "cpl");
      const persona60 = medianFor(medians ?? [], c.persona, "cost60");
      const spend = n(c.spend) ?? 0;
      const leads = n(c.matched_leads) ?? 0;
      const attendees = n(c.attendees) ?? 0;
      const cpl = leads > 0 ? spend / leads : null;
      const attendance = leads > 0 ? attendees / leads : null;

      // TESTING → PROMISING
      if (c.state === "TESTING" && personaCpl) {
        const winners = (byConcept.get(c.concept_id) ?? [])
          .map((id) => regById.get(id))
          .filter((r): r is NonNullable<typeof r> => Boolean(r))
          .map((r) => ({
            script_code: r.script_code,
            spend: n(r.spend) ?? 0,
            leads: n(r.tracked_leads) ?? 0,
          }))
          .filter((r) => r.spend >= RULES.iterationSpend && r.leads > 0 && r.spend / r.leads < personaCpl.value);

        if (winners.length >= 2 && attendance !== null && attendance >= RULES.attendanceMin) {
          await raiseReviewItem(pg, {
            kind: "concept_transition",
            refId: `${c.concept_id}:PROMISING`,
            title: `Promote "${plainConcept(c.persona, c.pain, c.promise)}" to promising`,
            detail: `${winners.length} iterations beat the ${personaCpl.basis} of ₹${Math.round(personaCpl.value)} at ₹${RULES.iterationSpend} spend each, and concept attendance is ${(attendance * 100).toFixed(1)}%.`,
            evidence: {
              concept_id: c.concept_id,
              to_state: "PROMISING",
              persona_median_cpl: Math.round(personaCpl.value),
              median_basis: personaCpl.basis,
              winners,
              attendance_pct: Number((attendance * 100).toFixed(1)),
              concept_cpl: cpl === null ? null : Math.round(cpl),
              reference_cpl: cpl === null ? null : Math.round(cpl),
            },
          });
          proposed += 1;
        }
      }

      // → PROVEN
      if (c.state === "PROMISING" || c.state === "TESTING") {
        const matured = n(c.matured_leads) ?? 0;
        const sales = n(c.matured_sales) ?? 0;
        const rate = matured > 0 ? sales / matured : null;
        const a60 = n(c.attendees_60) ?? 0;
        const cost60 = a60 > 0 ? spend / a60 : null;
        if (
          matured >= RULES.provenLeads &&
          rate !== null &&
          acctRate !== null &&
          rate >= acctRate &&
          cost60 !== null &&
          persona60 &&
          cost60 <= persona60.value
        ) {
          await raiseReviewItem(pg, {
            kind: "concept_transition",
            refId: `${c.concept_id}:PROVEN`,
            title: `Call "${plainConcept(c.persona, c.pain, c.promise)}" proven`,
            detail: `${matured} matured matched leads at a ${(rate * 100).toFixed(1)}% sale rate against the account's ${(acctRate * 100).toFixed(1)}%, with cost per 60-minute attendee of ₹${Math.round(cost60)} against the ${persona60.basis} of ₹${Math.round(persona60.value)}.`,
            evidence: {
              concept_id: c.concept_id,
              to_state: "PROVEN",
              matured_leads: matured,
              matured_sales: sales,
              sale_rate_pct: Number((rate * 100).toFixed(1)),
              account_sale_rate_pct: Number((acctRate * 100).toFixed(1)),
              cost_per_60_inr: Math.round(cost60),
              persona_median_cost_60_inr: Math.round(persona60.value),
              median_basis: persona60.basis,
              reference_cpl: cpl === null ? null : Math.round(cpl),
            },
          });
          proposed += 1;
        }
      }

      // PROVEN → FATIGUED
      if (c.state === "PROVEN") {
        const ref = n(c.reference_cpl);
        const wk = weekById.get(c.concept_id);
        const pv = prevById.get(c.concept_id);
        const cpl7 = n(wk?.cpl_7d);
        const cplPrevWeek = n(pv?.cpl_7d);
        const spend7 = n(wk?.spend_7d) ?? 0;
        const spendPrev = n(pv?.spend_7d) ?? 0;
        const flat =
          spendPrev > 0 ? Math.abs(spend7 - spendPrev) / spendPrev <= RULES.fatigueSpendFlat : false;
        const twoWeeksOver =
          ref !== null &&
          cpl7 !== null &&
          cplPrevWeek !== null &&
          cpl7 > ref * RULES.fatigueMultiple &&
          cplPrevWeek > ref * RULES.fatigueMultiple;

        const freq = n(wk?.frequency_7d);
        const rateNow = n(wk?.rate_60_7d);
        const ratePrev = n(wk?.rate_60_prev7);
        const secondary =
          (freq !== null && freq > RULES.fatigueFrequency) ||
          (rateNow !== null && ratePrev !== null && ratePrev > 0 && (ratePrev - rateNow) / ratePrev >= RULES.fatigueRateDrop);

        if (twoWeeksOver && flat) {
          await raiseReviewItem(pg, {
            kind: "concept_transition",
            refId: `${c.concept_id}:FATIGUED`,
            title: `Mark "${plainConcept(c.persona, c.pain, c.promise)}" as tired`,
            detail: `Trailing-7d cost per registration is ₹${Math.round(cpl7!)} against a reference of ₹${Math.round(ref!)} for two consecutive weeks, with spend flat within ${Math.round(RULES.fatigueSpendFlat * 100)}%.`,
            evidence: {
              concept_id: c.concept_id,
              to_state: "FATIGUED",
              reference_cpl_inr: Math.round(ref!),
              cpl_7d_inr: Math.round(cpl7!),
              cpl_previous_week_inr: Math.round(cplPrevWeek!),
              spend_7d_inr: Math.round(spend7),
              spend_previous_week_inr: Math.round(spendPrev),
              secondary_signal_present: secondary,
              frequency_7d: freq === null ? null : Number(freq.toFixed(2)),
            },
          });
          proposed += 1;
        }
      }
    }

    return { status: "success", evaluated: (ledger ?? []).length, proposed, notes, error: null };
  } catch (e) {
    return { status: "error", evaluated: 0, proposed, notes, error: safeMessage(e) };
  }
}
