import { useQuery } from "@tanstack/react-query";

import { getSafetyNet } from "@/lib/safety-net.functions";

/**
 * THE NET, IN FULL, FOR THE BUILDER.
 *
 * The owner's screen carries one line. This carries the working: every
 * scheduled job and when it last started, every feed and how recent its data
 * actually is, every credential with an expiry, and every retry in the last
 * week — because a feed that only survives by retrying is on its way to
 * failing, and that must be visible before it does.
 *
 * Read live on render, never from the scheduler: if the scheduler stops, the
 * check that notices must not stop with it.
 */
export function SafetyNetPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ["safety-net"],
    queryFn: () => getSafetyNet(),
    refetchInterval: 120_000,
  });

  if (isLoading) {
    return <p className="mt-2 text-[12px] text-muted-foreground">Checking the net…</p>;
  }
  if (!data?.configured) {
    return <p className="mt-2 text-[12px] text-muted-foreground">no data</p>;
  }

  const late = data.jobs.filter((j) => j.status !== "on_time" && j.status !== "not_due_yet");
  const stalled = data.feeds.filter((f) => f.stalled);

  return (
    <section className="mt-6">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Nothing stops silently
      </h2>
      {data.error ? (
        <p className="text-destructive mt-1 text-[12px]">{data.error}</p>
      ) : null}
      <p className="mt-1 text-[11px] text-muted-foreground">
        {late.length === 0 && stalled.length === 0
          ? "Every scheduled job started within its own interval and every feed is bringing new data."
          : `${late.length} job(s) overdue · ${stalled.length} feed(s) bringing nothing new.`}
        {data.selfTest?.checked_at
          ? ` Alarms last tested ${new Date(data.selfTest.checked_at).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
              timeZone: "Asia/Kolkata",
            })}${data.selfTest.ok ? " — all testable." : " — see problems below."}`
          : " Alarms have not been tested yet."}
      </p>

      <div className="border-border bg-card mt-2 overflow-x-auto rounded-md border">
        <table className="w-full text-[12px]">
          <thead className="text-muted-foreground border-border border-b">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Job</th>
              <th className="px-3 py-2 text-left font-medium">Due every</th>
              <th className="px-3 py-2 text-left font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {data.jobs.map((j) => (
              <tr key={j.jobname} className="border-border/60 border-b last:border-0">
                <td className="px-3 py-1.5">{j.plain_label}</td>
                <td className="nums px-3 py-1.5 text-muted-foreground">
                  {Number(j.cadence_hours) >= 24
                    ? `${Math.round(Number(j.cadence_hours) / 24)}d`
                    : `${Math.round(Number(j.cadence_hours))}h`}
                </td>
                <td
                  className={`px-3 py-1.5 ${
                    j.status === "on_time" || j.status === "not_due_yet"
                      ? "text-muted-foreground"
                      : "text-destructive font-medium"
                  }`}
                >
                  {j.sentence}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-border bg-card mt-3 rounded-md border px-3 py-2">
        <p className="text-[11px] font-medium">Is each feed still bringing new data?</p>
        <ul className="mt-1 space-y-0.5 text-[12px] text-muted-foreground">
          {data.feeds.map((f) => (
            <li key={f.feed} className={f.stalled ? "text-destructive" : undefined}>
              {f.sentence}
            </li>
          ))}
        </ul>
      </div>

      <div className="border-border bg-card mt-3 rounded-md border px-3 py-2">
        <p className="text-[11px] font-medium">Connections and their expiry</p>
        <ul className="mt-1 space-y-0.5 text-[12px] text-muted-foreground">
          {data.credentials.map((c) => (
            <li key={c.key} className={c.level === "critical" ? "text-destructive" : undefined}>
              {c.sentence}
            </li>
          ))}
        </ul>
      </div>

      <div className="border-border bg-card mt-3 rounded-md border px-3 py-2">
        <p className="text-[11px] font-medium">Retries in the last 7 days</p>
        {data.retries.length === 0 ? (
          <p className="mt-1 text-[12px] text-muted-foreground">
            Nothing had to be retried — every feed arrived first time.
          </p>
        ) : (
          <ul className="mt-1 space-y-0.5 text-[12px] text-muted-foreground">
            {data.retries.map((r) => (
              <li key={`${r.source}-${r.step}`}>
                <span className="text-foreground">{r.source}</span> · {r.step} — {r.retries} retry
                {r.retries === 1 ? "" : "s"}, last {new Date(r.last_at).toLocaleString("en-IN", {
                  timeZone: "Asia/Kolkata",
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
                {r.last_reason ? ` — ${r.last_reason.slice(0, 120)}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
