import { useQuery } from "@tanstack/react-query";

import { asAtLabel, sourceHealth, syncHealthQuery } from "@/lib/sync-health";

/**
 * Dates a figure whose source is not current: "Meta spend as at 26 Aug".
 * A stale number rendered plainly is a lie by omission, so the wrapper also
 * dims and underlines the value it sits beside.
 */
export function StaleBadge({ source, what }: { source: string; what: string }) {
  const { data } = useQuery(syncHealthQuery());
  const health = sourceHealth(data, source);
  if (!health || health.status === "ok") return null;

  const at = asAtLabel(health.last_success);
  return (
    <span
      title={health.last_error ?? undefined}
      className={`ml-2 inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        health.status === "dead"
          ? "bg-destructive/15 text-destructive"
          : "bg-warning/15 text-warning"
      }`}
    >
      {at ? `${what} as at ${at}` : `${what} never synced`}
    </span>
  );
}

/** Wraps a figure so a stale source renders it visibly degraded. */
export function StaleWrap({ source, children }: { source: string; children: React.ReactNode }) {
  const { data } = useQuery(syncHealthQuery());
  const health = sourceHealth(data, source);
  const stale = health && health.status !== "ok";
  return (
    <span
      className={
        stale
          ? "decoration-warning/60 opacity-70 underline decoration-dotted underline-offset-4"
          : undefined
      }
    >
      {children}
    </span>
  );
}
