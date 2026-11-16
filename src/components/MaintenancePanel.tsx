import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { clearJobStandDown, getJobStandDown } from "@/lib/jobs.functions";
import { runProofNow } from "@/lib/proof.functions";

/**
 * The two controls an owner needs when the pipeline looks stuck: re-run the
 * checks, and lift the stand-down that keeps the background jobs paused.
 */
export function MaintenancePanel() {
  const qc = useQueryClient();
  const readStandDown = useServerFn(getJobStandDown);
  const clear = useServerFn(clearJobStandDown);
  const rerun = useServerFn(runProofNow);
  const [note, setNote] = useState<string | null>(null);

  const standDown = useQuery({
    queryKey: ["job-stand-down"],
    queryFn: () => readStandDown(),
    refetchInterval: 60_000,
  });

  const clearing = useMutation({
    mutationFn: () => clear(),
    onSuccess: (r) => {
      setNote(r.cleared ? "Background jobs may run again." : "Nothing to clear.");
      void qc.invalidateQueries({ queryKey: ["job-stand-down"] });
    },
    onError: () => setNote("The stand-down could not be lifted. Try again in a moment."),
  });

  const rerunning = useMutation({
    mutationFn: () => rerun({ data: { since: null, until: null } }),
    onSuccess: () => {
      setNote("Checks re-run. The panel above now shows the fresh result.");
      void qc.invalidateQueries();
    },
    onError: () => setNote("The checks could not be re-run just now."),
  });

  const s = standDown.data;
  const paused = s?.open === true;

  return (
    <section className="border-border bg-card rounded-md border">
      <header className="border-border flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight">Controls</h2>
        <span className="text-muted-foreground text-[12px]">
          {standDown.isPending
            ? "checking…"
            : paused
              ? "background jobs are paused"
              : "background jobs are running"}
        </span>
      </header>

      <div className="px-4 py-3 text-[13px]">
        {paused && (
          <p className="mb-3 leading-relaxed">
            Heavy jobs stood down after repeated failures
            {s?.reason ? ` (${s.reason})` : ""}
            {s?.until ? `, until ${new Date(s.until).toLocaleTimeString("en-IN")}` : ""}. Nothing is
            lost — each job resumes from where it stopped.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => rerunning.mutate()}
            disabled={rerunning.isPending}
            className="border-border hover:bg-muted rounded border px-3 py-1.5 text-[13px] disabled:opacity-50"
          >
            {rerunning.isPending ? "Re-running the checks…" : "Re-run the checks now"}
          </button>

          <button
            type="button"
            onClick={() => clearing.mutate()}
            disabled={clearing.isPending || !paused}
            className="border-border hover:bg-muted rounded border px-3 py-1.5 text-[13px] disabled:opacity-50"
          >
            {clearing.isPending ? "Lifting the pause…" : "Let background jobs run again"}
          </button>
        </div>

        {note && <p className="text-muted-foreground mt-3 text-[12px]">{note}</p>}
      </div>
    </section>
  );
}
