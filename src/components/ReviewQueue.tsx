import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UiError } from "@/components/UiError";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resolveReviewItem } from "@/lib/concepts.functions";
import type { ReviewItem } from "@/lib/review.server";

const KIND_LABEL: Record<string, string> = {
  script_transcript_missing: "Transcript missing",
  script_tags: "Machine tags — confirm",
  concept_proposal: "New concept proposed",
  source_disagreement: "Two sources disagree",
  concept_transition: "State change proposed",
  ad_script_mapping: "Ad ↔ script mapping",
  contract_drift: "A definition needs re-signing",
  golden_failure: "A signed-off figure changed",
  watchdog_recalibration: "A check is raising too many alarms",
  performance: "Something is running slowly",
  job_failure: "A job failed",
  owner_action: "Needs an answer",
  new_ad_account: "New ad account — who runs it?",
  concept_concurrency: "Too many ideas running at once",
};

/**
 * Nothing in the creative layer changes state on its own. Machine work lands
 * here as a proposal with its evidence attached, and a person confirms it.
 */
export function ReviewQueue({
  items,
  error,
  loading,
}: {
  items: ReviewItem[];
  error?: string | null;
  loading?: boolean;
}) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});
  // A save that failed and a save that worked must never look the same.
  const [applied, setApplied] = useState<{ ok: boolean; text: string } | null>(null);

  const resolve = useMutation({
    mutationFn: (vars: { id: string; confirm: boolean; note?: string }) =>
      resolveReviewItem({ data: vars }),
    onSuccess: (res) => {
      if (res.error) {
        setApplied({ ok: false, text: "That decision was not saved. Please try again." });
        return;
      }
      setApplied({ ok: true, text: res.applied ?? "Decision saved." });
      void qc.invalidateQueries({ queryKey: ["concepts"] });
      void qc.invalidateQueries({ queryKey: ["review"] });
      void qc.invalidateQueries({ queryKey: ["creative"] });
    },
    onError: () => {
      setApplied({ ok: false, text: "That decision was not saved. Please try again." });
    },
  });

  return (
    <section className="space-y-2">
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Awaiting a decision</h2>
        <span className="text-[11px] text-muted-foreground">
          {error
            ? "queue unreadable"
            : loading
              ? "still reading"
              : items.length === 0
                ? "nothing open"
                : `${items.length} item${items.length === 1 ? "" : "s"}`}{" "}
          · machine proposals only take effect once confirmed here
        </span>
        {applied ? (
          <span
            role="status"
            className={`text-[11px] font-medium ${applied.ok ? "text-positive" : "text-destructive"}`}
          >
            {applied.text}
          </span>
        ) : null}
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
        >
          The queue could not be read — this is not "nothing open".{" "}
          <UiError detail={error} subject="the queue" where="review queue" className="inline" />
        </div>
      ) : null}

      {loading && !error ? (
        <div className="rounded border border-border px-3 py-4 text-[12px] text-muted-foreground">
          Reading the queue…
        </div>
      ) : items.length === 0 && !error ? (
        <div className="rounded border border-border px-3 py-4 text-[12px] text-muted-foreground">
          No open review items.
        </div>
      ) : items.length === 0 ? null : (
        <ul className="space-y-2">
          {items.map((it) => (
            <li key={it.id} className="rounded border border-border px-3 py-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {KIND_LABEL[it.kind] ?? it.kind}
                </span>
                <span className="text-[12px] font-medium">{it.title}</span>
              </div>
              {it.detail ? (
                <p className="mt-1 text-[11px] text-muted-foreground">{it.detail}</p>
              ) : null}
              {/* Engineer detail: kept, but folded away so driver text and raw
                  JSON never sit in the owner's reading line. */}
              <details className="mt-1">
                <summary className="cursor-pointer text-[11px] text-muted-foreground">
                  Technical detail
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted/50 px-2 py-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {it.ref_id ? `ref ${it.ref_id}\n` : ""}
                  {JSON.stringify(it.evidence, null, 1)}
                </pre>
              </details>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Input
                  value={notes[it.id] ?? ""}
                  placeholder="Reason for the record (optional)"
                  className="h-7 max-w-sm text-[11px]"
                  onChange={(e) => setNotes((p) => ({ ...p, [it.id]: e.target.value }))}
                />
                <Button
                  size="sm"
                  className="h-7 text-[11px]"
                  disabled={resolve.isPending}
                  onClick={() =>
                    resolve.mutate({
                      id: it.id,
                      confirm: true,
                      ...(notes[it.id]?.trim() ? { note: notes[it.id] as string } : {}),
                    })
                  }
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-[11px]"
                  disabled={resolve.isPending}
                  onClick={() =>
                    resolve.mutate({
                      id: it.id,
                      confirm: false,
                      ...(notes[it.id]?.trim() ? { note: notes[it.id] as string } : {}),
                    })
                  }
                >
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
