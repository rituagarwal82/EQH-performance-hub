import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Clock } from "lucide-react";

import { asAtLabel, hoursLabel, syncHealthQuery, worstSource } from "@/lib/sync-health";

/**
 * Global freshness band. Reads the WORST source, never an average, and cannot
 * be dismissed — a dashboard that lets you hide a dead pipeline is how four
 * days of stale numbers got served as current.
 */
export function FreshnessBanner() {
  const { data } = useQuery(syncHealthQuery());
  const worst = worstSource(data);
  if (!worst || worst.status === "ok") return null;

  const dead = worst.status === "dead";
  const since = worst.last_success
    ? `last succeeded ${hoursLabel(worst.hours_since_success)} ago (${asAtLabel(worst.last_success)})`
    : "has never completed a successful run";

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`flex items-center gap-2 px-5 py-2 text-[12px] font-medium ${
        dead
          ? "bg-destructive text-destructive-foreground"
          : "bg-warning/20 text-foreground border-warning border-b"
      }`}
    >
      {dead ? <AlertTriangle className="size-4 shrink-0" /> : <Clock className="size-4 shrink-0" />}
      <span>
        {dead ? "Data has stopped arriving" : "Data is arriving late"} —{" "}
        <strong>{worst.label}</strong> {since}.
        {data && data.sources.filter((s) => s.status !== "ok").length > 1
          ? ` ${data.sources.filter((s) => s.status !== "ok").length} sources are not current.`
          : ""}{" "}
        Figures below this line are as at the last successful run, not today.
      </span>
      <Link
        to="/trust"
        search={{ range: "this_month" as const, compare: true }}

        className="ml-auto shrink-0 underline underline-offset-2"
      >
        Data Trust
      </Link>
    </div>
  );
}
