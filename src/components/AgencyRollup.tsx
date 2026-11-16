import { useQuery } from "@tanstack/react-query";

import { MetricValue } from "@/components/MetricValue";
import { accountView, totals as computeTotals } from "@/lib/account-view";
import { count } from "@/lib/counts";
import { NO_DATA } from "@/lib/format";
import { getOverview } from "@/lib/dashboard.functions";

/**
 * Absorbed from the old /agencies screen. Sales still cannot be split by
 * agency, so this is a spend-and-registration rollup in a proper empty-state
 * container — never a KPI slot pretending to know agency revenue.
 */
export function AgencyRollup({ since, until }: { since: string; until: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["overview", "agency-rollup", since, until],
    queryFn: () => getOverview({ data: { range: "custom", since, until, compare: false } }),
  });

  const rangeDays = data?.coverage?.clippedDays;
  const views = (data?.accounts ?? []).map((r) => accountView(r, { rangeDays }));
  const groups = new Map<string, typeof views>();
  for (const v of views) {
    const key = v.row.agency_code ?? "UNASSIGNED";
    const list = groups.get(key) ?? [];
    list.push(v);
    groups.set(key, list);
  }
  const rows = Array.from(groups.entries())
    .map(([code, list]) => ({ code, list, t: computeTotals(list) }))
    .sort((a, b) => (b.t.spend.value ?? -Infinity) - (a.t.spend.value ?? -Infinity));

  return (
    <section>
      <h2 className="mb-1 text-[12px] font-semibold">Teams</h2>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[12px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Team</th>
              <th className="px-3 py-1.5 text-right font-medium">Accounts</th>
              <th className="px-3 py-1.5 text-right font-medium">Measured accounts</th>
              <th className="px-3 py-1.5 text-right font-medium">Meta spend</th>
              <th className="px-3 py-1.5 text-right font-medium">Registrations (measured)</th>
              <th className="px-3 py-1.5 text-right font-medium">Cost per registration</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                  {NO_DATA}
                </td>
              </tr>
            ) : (
              rows.map(({ code, list, t }) => (
                <tr key={code} className="border-t border-border/60 hover:bg-muted/40">
                  <td className="px-3 py-1 font-medium">{code}</td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    {count(list.length)}
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums text-muted-foreground">
                    {count(list.filter((v) => v.tracking === "working").length)} of{" "}
                    {count(list.length)}
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={t.spend} format="inr" emphasis />
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue metric={t.measuredLeads} format="int" />
                  </td>
                  <td className="px-3 py-1 text-right font-mono tabular-nums">
                    <MetricValue
                      metric={t.costPerMeasuredRegistration}
                      format="inr"
                      contract="cost_per_registration"
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Cost per registration is computed only over accounts whose lead tracking is marked working,
        and both sides of it — spend and registrations — are read off the same accounts, which is
        why it may be split by team while the cash ratios may not. The sales column is an em dash
        for every agency because the ledger carries no agency code — sales cannot be split by agency
        until ad-level codes reach the lead records.
      </p>
    </section>
  );
}
