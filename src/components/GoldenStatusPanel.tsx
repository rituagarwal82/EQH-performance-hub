import { useQuery } from "@tanstack/react-query";
import { UiError } from "@/components/UiError";
import { useServerFn } from "@tanstack/react-start";

import { count } from "@/lib/counts";
import { NO_DATA } from "@/lib/format";
import { fromNullable } from "@/lib/metric";
import { MetricValue } from "@/components/MetricValue";
import { getGoldenStatus } from "@/lib/goldens.functions";

/**
 * Figures signed off by hand, re-checked against what the code returns today.
 * Lives on Data Trust — it is a statement about whether the engine can still be
 * believed, not about whether a feed arrived.
 */
export function GoldenStatusPanel() {
  const fn = useServerFn(getGoldenStatus);
  const { data } = useQuery({ queryKey: ["golden-status"], queryFn: () => fn() });
  if (!data?.configured) return null;
  if (data.error) {
    return (
      <div className="border-destructive/40 bg-destructive/10 mb-5 rounded-md border px-4 py-2.5 text-xs text-destructive">
        <UiError detail={data.error} subject="the verified-figure checks" where="golden status" />
      </div>
    );
  }
  if (data.goldens.length === 0) return null;

  const failed = data.goldens.filter((g) => g.pass === false);
  const never = data.goldens.filter((g) => g.pass === null);
  // Rupee figures print as rupees; counts and ratios print as themselves.
  const isMoney = (metric: string) =>
    /(spend|cash|collect|revenue|cost_per|ticket)/.test(metric) && !/roas|rate|pct/.test(metric);
  const money = (metric: string, v: number | null) =>
    v === null ? (
      <>{NO_DATA}</>
    ) : (
      <MetricValue metric={fromNullable(v)} format={isMoney(metric) ? "inr" : "decimal"} />
    );

  const dep = data.lastDeploy;

  return (
    <div className="mb-5 space-y-2">
      <div
        className={`rounded-md border px-4 py-2.5 text-xs ${
          failed.length
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : never.length
              ? "border-warning/40 bg-warning/10 text-warning"
              : "border-border bg-card text-muted-foreground"
        }`}
      >
        <span className="font-medium">Verified figures</span>{" "}
        {failed.length
          ? `— ${count(failed.length)} of ${count(data.goldens.length)} no longer reproduce. The figures below were signed off by hand; the code now returns something else.`
          : never.length === data.goldens.length
            ? `— ${count(data.goldens.length)} recorded, none re-checked yet. The check runs nightly at 06:20 UTC.`
            : `— all ${count(data.goldens.length)} still reproduce exactly. Re-checked nightly at 06:20 UTC.`}
        {" · "}
        {count(data.contracts.length)} metric definitions on record
        {dep
          ? ` · last release ${dep.deploy_ref}: ${dep.verify_status ?? "not verified"}${
              dep.verify_status === "failed"
                ? ` (${count(dep.goldens_fail === null || dep.goldens_fail === undefined ? 0 : dep.goldens_fail)} figures off, ${count(dep.invariants_diverged === null || dep.invariants_diverged === undefined ? 0 : dep.invariants_diverged)} structure checks failing)`
                : ""
            }`
          : ""}
      </div>

      <div className="border-border bg-card overflow-x-auto rounded-md border">
        <table className="w-full text-[12px]">
          <thead className="border-border bg-muted/60 border-b text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Verified figure</th>
              <th className="px-3 py-2 text-left font-medium">Window</th>
              <th className="px-3 py-2 text-right font-medium">Signed off</th>
              <th className="px-3 py-2 text-right font-medium">Code returns</th>
              <th className="px-3 py-2 text-left font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {data.goldens.map((g) => (
              <tr key={g.golden_id} className="border-border border-b last:border-b-0">
                <td className="px-3 py-2">
                  <span className="font-medium">{g.metric_id}</span>
                  {g.note ? <span className="ml-2 text-muted-foreground">{g.note}</span> : null}
                </td>
                <td className="nums px-3 py-2 text-muted-foreground">
                  {g.window_start} → {g.window_end}
                </td>
                <td className="nums px-3 py-2 text-right">
                  {money(g.metric_id, g.expected_value)}
                </td>
                <td className="nums px-3 py-2 text-right">
                  {g.pass === null ? (
                    <span className="text-muted-foreground italic">not re-checked yet</span>
                  ) : (
                    money(g.metric_id, g.computed_value)
                  )}
                </td>
                <td className="px-3 py-2">
                  {g.error ? (
                    <span className="text-destructive">could not compute — {g.error}</span>
                  ) : g.pass === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : g.pass ? (
                    <span className="text-muted-foreground">reproduces</span>
                  ) : (
                    <span className="text-destructive font-medium">
                      off by {money(g.metric_id, Math.abs(g.delta === null ? 0 : g.delta))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
