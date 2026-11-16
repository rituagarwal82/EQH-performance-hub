import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import type { BalanceRow, LedgerRow, PersonaMedian } from "./concepts.server";
import type { ReviewItem } from "./review.server";
import { safeMessage } from "./safe-error";

/** Server functions behind the concept ledger, the review queue and the seeds. */

export type ConceptView = LedgerRow & {
  cpl: number | null;
  persona_median_cpl: number | null;
  cost_per_60: number | null;
  persona_median_cost_60: number | null;
  median_basis: string | null;
  attendance: number | null;
  sale_rate: number | null;
  sale_rate_status: string;
  fatigue: string | null;
};

export type ConceptData = {
  concepts: ConceptView[];
  balance: BalanceRow[];
  medians: PersonaMedian[];
  review: ReviewItem[];
  live_count: number;
  concurrency_limit: number;
  proven_leads_threshold: number;
  error: string | null;
};

const EMPTY: ConceptData = {
  concepts: [],
  balance: [],
  medians: [],
  review: [],
  live_count: 0,
  concurrency_limit: 6,
  proven_leads_threshold: 1000,
  error: null,
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

export const getConceptData = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => z.object({ since: z.string(), until: z.string() }).parse(data))
  .handler(async ({ data }): Promise<ConceptData> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const { medianFor, RULES } = await import("./concepts.server");
    const { openItems } = await import("./review.server");
    const pg = getPg();
    if (!pg) return EMPTY;
    try {
      const [ledger, medians, balance, weekly, review] = await Promise.all([
        pgRpc<LedgerRow[]>(pg, "concept_ledger", { p_start: data.since, p_end: data.until }),
        pgRpc<PersonaMedian[]>(pg, "persona_medians", { p_days: RULES.medianWindowDays }),
        pgRpc<BalanceRow[]>(pg, "portfolio_balance", { p_days: 30 }),
        pgRpc<{ concept_id: string; cpl_7d: number | string | null }[]>(pg, "concept_weekly_stats", {
          p_end: data.until,
        }),
        openItems(pg),
      ]);

      const week = new Map((weekly ?? []).map((w) => [w.concept_id, num(w.cpl_7d)]));

      const concepts: ConceptView[] = (ledger ?? []).map((c) => {
        const spend = num(c.spend) ?? 0;
        const leads = num(c.matched_leads) ?? 0;
        const attendees = num(c.attendees) ?? 0;
        const a60 = num(c.attendees_60) ?? 0;
        const matured = num(c.matured_leads) ?? 0;
        const cplMed = medianFor(medians ?? [], c.persona, "cpl");
        const c60Med = medianFor(medians ?? [], c.persona, "cost60");
        const ref = num(c.reference_cpl);
        const cpl7 = week.get(c.concept_id) ?? null;
        return {
          ...c,
          cpl: leads > 0 ? spend / leads : null,
          persona_median_cpl: cplMed?.value ?? null,
          cost_per_60: a60 > 0 ? spend / a60 : null,
          persona_median_cost_60: c60Med?.value ?? null,
          median_basis: cplMed?.basis ?? null,
          attendance: leads > 0 ? attendees / leads : null,
          sale_rate: matured >= RULES.provenLeads ? (num(c.matured_sales) ?? 0) / matured : null,
          sale_rate_status:
            matured >= RULES.provenLeads
              ? "reportable"
              : `accumulating — ${matured} of ${RULES.provenLeads}`,
          fatigue:
            ref !== null && cpl7 !== null
              ? cpl7 > ref * RULES.fatigueMultiple
                ? `7d cost per registration is above ${RULES.fatigueMultiple}× reference`
                : "within reference"
              : null,
        };
      });

      const live = concepts.filter((c) => c.state === "TESTING" || c.state === "PROMISING").length;

      return {
        concepts,
        balance: balance ?? [],
        medians: medians ?? [],
        review: review ?? [],
        live_count: live,
        concurrency_limit: RULES.concurrencyMax,
        proven_leads_threshold: RULES.provenLeads,
        error: null,
      };
    } catch (e) {
      return { ...EMPTY, error: safeMessage(e) };
    }
  });

/**
 * One-click resolution of a review item. Confirming is what applies the
 * decision — nothing in the automated layer writes state on its own.
 */
export const resolveReviewItem = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        confirm: z.boolean(),
        note: z.string().max(400).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; applied: string | null; error: string | null }> => {
    const { getPg, pgSelect, pgUpdate } = await import("./pg.server");
    const { openConcept, applyTransition } = await import("./concepts.server");
    const pg = getPg();
    if (!pg) return { ok: false, applied: null, error: "Backend not configured." };

    try {
      const rows =
        (await pgSelect<
          { id: string; kind: string; ref_id: string | null; evidence: Record<string, unknown> }[]
        >(pg, `/review_items?select=id,kind,ref_id,evidence&id=eq.${data.id}&limit=1`)) ?? [];
      const item = rows[0];
      if (!item) return { ok: false, applied: null, error: "That review item no longer exists." };

      let applied: string | null = null;

      if (data.confirm) {
        const ev = item.evidence ?? {};
        if (item.kind === "script_tags" && item.ref_id) {
          await pgUpdate(pg, "script_tags", `script_id=eq.${encodeURIComponent(item.ref_id)}`, {
            confirmed: true,
            tagged_by: "human",
          });
          applied = "tags confirmed";
        } else if (item.kind === "concept_proposal") {
          const conceptId = await openConcept(pg, {
            persona: String(ev["persona"]),
            pain: String(ev["pain"]),
            promise: String(ev["promise"]),
            script_ids: (ev["script_ids"] as string[] | undefined) ?? [],
          });
          applied = `${conceptId} opened in TESTING`;
        } else if (item.kind === "concept_transition") {
          const conceptId = String(ev["concept_id"]);
          const toState = String(ev["to_state"]);
          const ref = ev["reference_cpl"];
          await applyTransition(
            pg,
            conceptId,
            toState,
            data.note?.trim() || `Confirmed from the review queue on the ledger's own numbers.`,
            ev,
            toState === "PROMISING" && typeof ref === "number" ? ref : null,
          );
          applied = `${conceptId} → ${toState}`;
        }
      }

      await pgUpdate(pg, "review_items", `id=eq.${data.id}`, {
        status: data.confirm ? "confirmed" : "rejected",
        resolved_note: data.note ?? null,
        resolved_at: new Date().toISOString(),
      });

      return { ok: true, applied, error: null };
    } catch (e) {
      return { ok: false, applied: null, error: safeMessage(e) };
    }
  });

