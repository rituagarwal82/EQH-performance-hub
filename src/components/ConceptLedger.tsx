import type { ConceptData } from "@/lib/concepts.functions";
import { formatINR, formatInt, formatPercent, NO_DATA } from "@/lib/format";
import { label, plainConcept, type TagField } from "@/lib/taxonomy";

/** The builder's dimension keys, read out in the owner's words. */
const DIMENSION_LABEL: Record<string, { text: string; field: TagField }> = {
  persona: { text: "who the ad speaks to", field: "persona" },
  spiritual_scale: { text: "how spiritual the ad is", field: "spiritual_scale" },
  hook_mechanism: { text: "how the ad opens", field: "hook_mechanism" },
};

const STATE_ORDER = ["PROVEN", "PROMISING", "TESTING", "FATIGUED", "RETIRED"];

/**
 * The concept ledger: the strategic cell (persona × pain × promise), not the
 * ad. Sale rate stays blank until the cell has enough matured leads to carry
 * one — an accumulating cell says so instead of showing a fragile number.
 */
export function ConceptLedger({ data }: { data: ConceptData }) {
  const rows = [...data.concepts].sort(
    (a, b) =>
      STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
      (Number(b.spend) || 0) - (Number(a.spend) || 0),
  );
  const byDimension = new Map<string, typeof data.balance>();
  for (const b of data.balance) {
    const list = byDimension.get(b.dimension) ?? [];
    list.push(b);
    byDimension.set(b.dimension, list);
  }
  const dimensions = [...byDimension.entries()];

  return (
    <section className="space-y-3">
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Concept ledger</h2>
        <span className="text-[11px] text-muted-foreground">
          {formatInt(data.live_count)} live of {data.concurrency_limit} concurrent · sale rate
          reported at {formatInt(data.proven_leads_threshold)} matured leads · no per-ad return on
          ad spend is shown anywhere, at any state
        </span>
      </header>

      <div className="space-y-2">
        {dimensions.length === 0 ? (
          <div className="rounded border border-border px-3 py-3 text-[12px] text-muted-foreground">
            Portfolio balance: {NO_DATA}
          </div>
        ) : (
          dimensions.map(([dimension, rowsForDim]) => (
            <div key={dimension} className="rounded border border-border">
              <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Portfolio balance — last 30 days of spend by{" "}
                {DIMENSION_LABEL[dimension]?.text ?? dimension}
              </div>
              <div className="flex flex-wrap gap-4 px-3 py-2 text-[11px]">
                {rowsForDim.map((b) => (
                  <div key={`${b.dimension}-${b.label}`} className="min-w-28">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {DIMENSION_LABEL[b.dimension]
                        ? label(DIMENSION_LABEL[b.dimension]!.field, b.label)
                        : b.label}
                    </div>
                    <div className="font-mono tabular-nums">{formatINR(b.spend)}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {b.share === null ? NO_DATA : formatPercent(Number(b.share))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[12px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Concept</th>
              <th className="px-3 py-1.5 text-left font-medium">State</th>
              <th className="px-3 py-1.5 text-right font-medium">Spend</th>
              <th className="px-3 py-1.5 text-right font-medium">Regs</th>
              <th className="px-3 py-1.5 text-right font-medium">Cost / reg</th>
              <th className="px-3 py-1.5 text-right font-medium">Persona median</th>
              <th className="px-3 py-1.5 text-right font-medium">Cost / 60-min</th>
              <th className="px-3 py-1.5 text-right font-medium">Attendance</th>
              <th className="px-3 py-1.5 text-right font-medium">Sale rate</th>
              <th className="px-3 py-1.5 text-left font-medium">Fatigue</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-2 py-6 text-center text-muted-foreground">
                  No concepts yet — they are opened from confirmed proposals in the review queue.
                </td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr key={c.concept_id} className="border-t border-border/60 hover:bg-muted/40">
                  <td className="px-3 py-1">
                    <div>{plainConcept(c.persona, c.pain, c.promise)}</div>
                    <div className="font-mono text-[10px] text-muted-foreground">
                      {c.concept_id}
                    </div>
                  </td>
                  <td className="px-3 py-1">{c.state}</td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    {formatINR(c.spend)}
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    {formatInt(c.matched_leads)}
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    {c.cpl === null ? NO_DATA : formatINR(c.cpl)}
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums text-muted-foreground">
                    {c.persona_median_cpl === null ? NO_DATA : formatINR(c.persona_median_cpl)}
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    {c.cost_per_60 === null ? NO_DATA : formatINR(c.cost_per_60)}
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    {c.attendance === null ? NO_DATA : formatPercent(c.attendance)}
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    {c.sale_rate === null ? (
                      <span className="text-[10px] text-muted-foreground">
                        {c.sale_rate_status}
                      </span>
                    ) : (
                      formatPercent(c.sale_rate)
                    )}
                  </td>
                  <td className="px-3 py-1 text-[11px] text-muted-foreground">
                    {c.fatigue ?? NO_DATA}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Medians are the persona's own last-90-day figures, so a concept is judged against comparable
        traffic rather than the account average. State changes are proposed by the weekly pass and
        applied only when a person confirms them.
      </p>
    </section>
  );
}
