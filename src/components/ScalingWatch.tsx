import { useQuery } from "@tanstack/react-query";

import { briefQuery } from "@/components/AnalystBrief";
import { count, inrText } from "@/lib/counts";
import { NO_DATA } from "@/lib/format";

/**
 * SCALING WATCH, read straight off the brief's stored evidence.
 *
 * Every figure here was computed server-side when the brief was written and
 * checked against its evidence set before saving. This panel does no
 * arithmetic of its own — it re-states stored numbers, and prints "no data"
 * wherever the evidence holds a null.
 */
export type ScalingWatch = {
  is_monday: boolean;
  weekday: string;
  trailing_7d: Record<string, number | null>;
  trailing_28d: Record<string, number | null>;
  efficiency_direction: string;
  capacity: {
    active_adsets_7d: number | null;
    fundable_adsets: number | null;
    over_capacity: boolean | null;
    learning_events_per_adset_per_week: number;
  };
  next_increment: {
    extra_spend_per_day_inr: number;
    extra_registrations_per_day: number | null;
    extra_matured_sales_per_week: number | null;
  };
  weekly_verdict: {
    applies_today: boolean;
    favours_raising_budget: boolean;
    conditions_failing: string[];
  };
};

export function useScalingWatch(): ScalingWatch | null {
  const { data } = useQuery(briefQuery());
  const evidence = data?.evidence as Record<string, unknown> | null | undefined;
  const raw = evidence?.["scaling_watch"];
  return raw && typeof raw === "object" ? (raw as ScalingWatch) : null;
}

/**
 * Open the section when it has something to say: Monday's verdict, efficiency
 * going the wrong way, or a week that does not favour raising budget.
 */
/** Machine status words never reach the screen. */
function directionWords(raw: string): string {
  const key = String(raw ?? "").toLowerCase();
  if (key.startsWith("degrading"))
    return key.includes("slight") ? "getting slightly worse" : "getting worse";
  if (key.startsWith("improving"))
    return key.includes("slight") ? "getting slightly better" : "getting better";
  if (key.startsWith("stable") || key.startsWith("flat")) return "holding steady";
  return key.replace(/_/g, " ");
}

export function scalingDemandsAttention(s: ScalingWatch | null): boolean {
  if (!s) return false;
  if (s.is_monday) return true;
  if (s.efficiency_direction.startsWith("degrading")) return true;
  return !s.weekly_verdict.favours_raising_budget;
}

const inr = (v: number | null | undefined) =>
  v === null || v === undefined ? NO_DATA : inrText(v);
const num = (v: number | null | undefined) => (v === null || v === undefined ? NO_DATA : count(v));

export function ScalingWatchPanel({ scaling }: { scaling: ScalingWatch | null }) {
  if (!scaling) {
    return (
      <p className="text-[12px] text-muted-foreground">
        No scaling figures yet — they are written with the morning brief.
      </p>
    );
  }
  const s7 = scaling.trailing_7d;
  const s28 = scaling.trailing_28d;
  const cap = scaling.capacity;
  const inc = scaling.next_increment;
  const wv = scaling.weekly_verdict;

  return (
    <div className="space-y-3 text-[12px]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[12px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Marginal efficiency</th>
              <th className="px-3 py-1.5 text-right font-medium">Trailing 7 days</th>
              <th className="px-3 py-1.5 text-right font-medium">Trailing 28 days</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            <tr className="border-t border-border/60">
              <td className="px-3 py-1 font-sans">Spend</td>
              <td className="px-3 py-1 text-right">{inr(s7["spend_inr"])}</td>
              <td className="px-3 py-1 text-right">{inr(s28["spend_inr"])}</td>
            </tr>
            <tr className="border-t border-border/60">
              <td className="px-3 py-1 font-sans">Cost per registration</td>
              <td className="px-3 py-1 text-right">{inr(s7["cost_per_registration_inr"])}</td>
              <td className="px-3 py-1 text-right">{inr(s28["cost_per_registration_inr"])}</td>
            </tr>
            <tr className="border-t border-border/60">
              <td className="px-3 py-1 font-sans">Cost per 60-minute attendee</td>
              <td className="px-3 py-1 text-right">{inr(s7["cost_per_60_min_attendee_inr"])}</td>
              <td className="px-3 py-1 text-right">{inr(s28["cost_per_60_min_attendee_inr"])}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p>
        Efficiency is{" "}
        <span className="font-medium">{directionWords(scaling.efficiency_direction)}</span>.
      </p>

      <p className="text-muted-foreground">
        {cap.fundable_adsets === null || cap.active_adsets_7d === null ? (
          <>Capacity: {NO_DATA} — the ad-set counts behind this were not available.</>
        ) : (
          <>
            Your spend can teach about {num(cap.fundable_adsets)} ad sets at{" "}
            {cap.learning_events_per_adset_per_week} lead events each per week. You are running{" "}
            {num(cap.active_adsets_7d)}
            {cap.over_capacity === true
              ? " — more than the spend can teach, so each one learns slowly."
              : cap.over_capacity === false
                ? " — within what the spend can teach."
                : "."}
          </>
        )}
      </p>

      <p className="text-muted-foreground">
        <span className="mr-1 rounded bg-muted px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Modelled
        </span>
        On current rates, another {inr(inc.extra_spend_per_day_inr)} a day would be expected to buy
        about {inc.extra_registrations_per_day === null ? NO_DATA : inc.extra_registrations_per_day}{" "}
        registrations a day and{" "}
        {inc.extra_matured_sales_per_week === null ? NO_DATA : inc.extra_matured_sales_per_week}{" "}
        matured sales a week. This is a projection from recent performance, not a measured result.
      </p>

      <div className="border-border rounded border px-3 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Weekly scale verdict
        </div>
        {wv.applies_today ? (
          <p className="mt-1">
            {wv.favours_raising_budget
              ? "This week favours raising budget."
              : `This week does not favour raising budget: ${wv.conditions_failing.join("; ")}.`}
          </p>
        ) : (
          <p className="mt-1 text-muted-foreground">
            The weekly scale verdict is written on Mondays. As things stand,{" "}
            {wv.favours_raising_budget
              ? "no condition is failing."
              : `these are failing: ${wv.conditions_failing.join("; ")}.`}
          </p>
        )}
      </div>
    </div>
  );
}
