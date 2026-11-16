import { NO_DATA } from "@/lib/format";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";

import { asAtLabel, hoursLabel, syncHealthQuery } from "@/lib/sync-health";
import { count } from "@/lib/counts";

const TONE: Record<string, string> = {
  ok: "text-success",
  late: "text-warning",
  dead: "text-destructive",
};

const RUN_TONE: Record<string, string> = {
  success: "text-success",
  success_no_yield: "text-warning",
  partial: "text-warning",
  warning: "text-warning",
  running: "text-muted-foreground",
  error: "text-destructive",
};

/**
 * The screen that answers "is anything lying to me right now". Status is
 * derived from the last SUCCESSFUL run only: late at 1.5x the expected cadence,
 * dead at 3x, and dead outright if the source has never succeeded.
 */
export function SyncHealthPanel() {
  const { data, isLoading } = useQuery(syncHealthQuery());
  const [open, setOpen] = useState<string | null>(null);

  if (isLoading) {
    return (
      <section className="border-border bg-card rounded-md border px-4 py-4 text-[12px] text-muted-foreground">
        Reading pipeline health…
      </section>
    );
  }
  if (!data || data.error) {
    return (
      <section className="border-destructive bg-card rounded-md border px-4 py-4 text-[12px] text-destructive">
        Pipeline health is unreadable: {data?.error ?? NO_DATA}. Treat every figure on this
        dashboard as unverified until this resolves.
      </section>
    );
  }

  return (
    <section className="border-border bg-card rounded-md border">
      <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Pipeline health
        </h2>
        <span className="text-[11px] text-muted-foreground">
          late at 1.5× cadence · dead at 3× · checked{" "}
          {new Date(data.checkedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-border border-b text-[10px] uppercase tracking-wider text-muted-foreground [&>th]:px-4 [&>th]:py-1.5 [&>th]:text-left">
              <th>Source</th>
              <th>Status</th>
              <th>Last success</th>
              <th className="text-right">Since</th>
              <th className="text-right">Failures since</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((s) => {
              const runs = data.runs.filter((r) => r.source === s.source);
              const isOpen = open === s.source;
              return (
                <Fragment key={s.source}>
                  <tr
                    onClick={() => setOpen(isOpen ? null : s.source)}

                    className="border-border cursor-pointer border-b last:border-b-0 hover:bg-muted/50 [&>td]:px-3 [&>td]:py-1.5"
                  >
                    <td className="font-medium">
                      {s.label}
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {s.source}
                      </span>
                    </td>
                    <td
                      className={`text-[11px] font-semibold uppercase tracking-wider ${TONE[s.status]}`}
                    >
                      {s.status}
                    </td>
                    <td className="nums text-[12px]">
                      {s.last_success ? asAtLabel(s.last_success) : "never"}
                    </td>
                    <td className="nums text-right">{hoursLabel(s.hours_since_success)}</td>
                    <td className="nums text-right">
                      {s.consecutive_failures > 0 ? count(s.consecutive_failures) : "—"}
                    </td>
                    <td className="max-w-[380px] truncate text-[11px] text-muted-foreground">
                      {s.last_error ?? "—"}
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr key={`${s.source}-runs`} className="border-border border-b bg-muted/30">
                      <td colSpan={6} className="px-4 py-2">
                        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                          Last {runs.length} runs — verbatim errors
                        </div>
                        {runs.length === 0 ? (
                          <p className="text-[12px] text-muted-foreground">
                            This source has never run. It is not failing — it was never scheduled.
                          </p>
                        ) : (
                          <ul className="space-y-1">
                            {runs.map((r) => (
                              <li key={`${r.source}-${r.started_at}`} className="text-[11px]">
                                <span className="nums text-muted-foreground">
                                  {new Date(r.started_at).toLocaleString("en-IN", {
                                    timeZone: "Asia/Kolkata",
                                  })}
                                </span>{" "}
                                <span
                                  className={`font-semibold uppercase ${RUN_TONE[r.status ?? ""] ?? ""}`}
                                >
                                  {r.status ?? "unknown"}
                                </span>{" "}
                                <span className="nums text-muted-foreground">
                                  {r.rows_written === null ? "" : `${count(r.rows_written)} rows`}
                                  {r.expected_rows === null || r.expected_rows === undefined
                                    ? ""
                                    : ` · ${count(Math.round(Number(r.expected_rows)))} expected`}
                                  {r.yield_verdict && r.yield_verdict !== "normal"
                                    ? ` · ${r.yield_verdict.replace(/_/g, " ")}`
                                    : ""}
                                </span>
                                {r.yield_note ? (
                                  <div className="pl-2 text-warning">{r.yield_note}</div>
                                ) : null}
                                {r.error ? (
                                  <div className="whitespace-pre-wrap break-words pl-2 text-destructive">
                                    {r.error}
                                  </div>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
