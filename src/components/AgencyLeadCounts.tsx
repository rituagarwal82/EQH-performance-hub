import { useQuery } from "@tanstack/react-query";
import { UiError } from "@/components/UiError";

import { count } from "@/lib/counts";
import { getAgencyLeadRollup } from "@/lib/agency.functions";

const CODE_LABEL: Record<string, string> = {
  SD: "Sabhi Digital (SD)",
  RJ: "In-house — Rajdeep (RJ)",
  PRM: "Parami (PRM)",
  UNASSIGNED: "No team code",
};

/**
 * Counts only. Both teams run inside the same ad accounts, so spend cannot be
 * attributed per team and no per-team cost per sale is derived here.
 */
export function AgencyLeadCounts({ since, until }: { since: string; until: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["agency-lead-rollup", since, until],
    queryFn: () => getAgencyLeadRollup({ data: { since, until } }),
  });

  const rows = data?.rows ?? [];
  const spendByCode = new Map((data?.spend ?? []).map((s) => [s.agency_code, s]));
  const unconnected = (data?.spend ?? []).filter((s) => !s.spend_synced);

  return (
    <section>
      <h2 className="mb-1 text-[12px] font-semibold">Teams (utm_source code)</h2>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[12px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Team</th>
              <th className="px-3 py-1.5 text-right font-medium">Leads</th>
              <th className="px-3 py-1.5 text-right font-medium">Registered</th>
              <th className="px-3 py-1.5 text-right font-medium">With email</th>
              <th className="px-3 py-1.5 text-right font-medium">Sales matched by email</th>
              <th className="px-3 py-1.5 text-left font-medium">Ad spend</th>
              <th className="px-3 py-1.5 text-left font-medium">Ratios</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={7} className="px-2 py-6 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-2 py-6 text-center text-muted-foreground">
                  no data
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.agency_code} className="border-t border-border/60">
                  <td className="px-3 py-1">{CODE_LABEL[r.agency_code] ?? r.agency_code}</td>
                  <td className="nums px-2 py-1 text-right">{count(Number(r.leads))}</td>
                  <td className="nums px-2 py-1 text-right">{count(Number(r.registered_leads))}</td>
                  <td className="nums px-2 py-1 text-right">{count(Number(r.leads_with_email))}</td>
                  <td className="nums px-2 py-1 text-right">{count(Number(r.sales))}</td>
                  <td className="px-3 py-1 text-[11px]">
                    {spendByCode.get(r.agency_code)?.spend_synced === false ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        not connected — spend unknown
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        connected, not splittable per team
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1 text-[11px]">
                    {spendByCode.get(r.agency_code)?.ratios_computable ? (
                      <span className="text-muted-foreground">
                        {spendByCode.get(r.agency_code)?.ratio_note ??
                          "own spend and own ads — ratios allowed"}
                      </span>
                    ) : (
                      <span
                        className="text-amber-600 dark:text-amber-400"
                        title={spendByCode.get(r.agency_code)?.ratio_note ?? undefined}
                      >
                        not measurable per team
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {data?.error ? (
        <UiError detail={data.error} subject="team lead counts" where="agency lead counts" className="mt-1" />
      ) : null}
      <p className="mt-1.5 max-w-3xl text-[11px] text-muted-foreground">
        The sales column counts ledger sales whose buyer email matches a lead in that team — a
        different question from the ledger sale count, so these figures do not add up to the sales
        total on Collections and are never used in a ratio.{" "}
        Spend split by team requires team-coded campaigns — counts only for now. Both teams run in
        the same ad accounts, so no per-team cost per sale is shown. Leads whose utm_source carries
        no team suffix stay unassigned rather than being guessed into a team.
        {unconnected.length > 0 ? (
          <>
            {" "}
            {unconnected.map((s) => CODE_LABEL[s.agency_code] ?? s.agency_code).join(", ")} ad
            account{unconnected.length > 1 ? "s are" : " is"} not yet connected — spend unknown, so
            any cash from those leads is held out of the paid-performance ratios and appears here as
            counts only.
          </>
        ) : null}
      </p>
    </section>
  );
}
