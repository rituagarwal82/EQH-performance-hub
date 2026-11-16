import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  confirmScriptTags,
  decideProposals,
  getScriptProposals,
  refreshScriptProposals,
  type ProposalRow,
} from "@/lib/script-proposals.functions";
import { plainConcept, plainHook } from "@/lib/taxonomy";
import { formatINR, formatInt } from "@/lib/format";

export function adsManagerHref(accountId: string | null, entityId: string) {
  const act = (accountId ?? "").replace(/^act_/, "");
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${act}&selected_ad_ids=${entityId}`;
}

/** Thumbnail + the two links every ad row carries on this screen. */
export function AdLinks({
  accountId,
  entityId,
  permalink,
}: {
  accountId: string | null;
  entityId: string;
  permalink: string | null;
}) {
  return (
    <span className="whitespace-nowrap text-[11px]">
      {permalink ? (
        <>
          <a className="underline" href={permalink} target="_blank" rel="noreferrer">
            Watch
          </a>
          {" · "}
        </>
      ) : null}
      <a
        className="underline"
        href={adsManagerHref(accountId, entityId)}
        target="_blank"
        rel="noreferrer"
      >
        Open in Ads Manager
      </a>
    </span>
  );
}

export function Thumb({ url }: { url: string | null }) {
  return url ? (
    <img src={url} alt="" loading="lazy" className="size-9 shrink-0 rounded object-cover" />
  ) : (
    <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded text-[9px] text-muted-foreground">
      none
    </div>
  );
}

/**
 * Coverage in money terms, then ONE list the owner confirms in bulk: proposed
 * ad → script links and the machine-written tags waiting on a human. Nothing
 * here is counted anywhere until it is confirmed.
 */
export function ScriptProposals() {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const { data, isLoading, isError } = useQuery({
    queryKey: ["script-proposals"],
    queryFn: () => getScriptProposals(),
  });

  const invalidate = () => {
    setPicked(new Set());
    void qc.invalidateQueries({ queryKey: ["script-proposals"] });
    void qc.invalidateQueries({ queryKey: ["creative"] });
  };

  const refresh = useMutation({ mutationFn: () => refreshScriptProposals(), onSuccess: invalidate });
  const decide = useMutation({
    mutationFn: (vars: { adEntityIds: string[]; confirm: boolean }) =>
      decideProposals({ data: vars }),
    onSuccess: invalidate,
  });
  const confirmTags = useMutation({
    mutationFn: (scriptIds: string[]) => confirmScriptTags({ data: { scriptIds } }),
    onSuccess: invalidate,
  });

  const rows: ProposalRow[] = data?.proposals ?? [];
  const tags = data?.pendingTags ?? [];
  const cov = data?.coverage;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const coverageLine = cov
    ? `${formatInt(Number(cov.ads_mapped))} of ${formatInt(Number(cov.ads_spent))} ads that spent in the last 30 days carry a script — ${formatINR(
        Number(cov.spend_mapped),
      )} of ${formatINR(Number(cov.spend_total))} of spend.`
    : "Coverage could not be read — this is not full coverage.";

  return (
    <section className="border-border bg-card space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Script coverage
        </h2>
        <button
          className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {refresh.isPending ? "Looking…" : "Look for matches again"}
        </button>
      </div>
      <p className="text-[12px]">{isError ? "Coverage could not be read." : coverageLine}</p>

      <div className="border-border border-t pt-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Waiting for you to confirm
        </h3>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Proposed only. Nothing below counts towards any figure or verdict until you confirm it.
        </p>

        {isLoading ? (
          <p className="py-3 text-[12px] text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-3 text-[12px] text-muted-foreground">
            No proposed script links. Use “Look for matches again” after adding scripts.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 py-2 text-[11px]">
              <button
                className="rounded border border-border px-2 py-0.5 hover:bg-muted"
                onClick={() => setPicked(new Set(rows.map((r) => r.ad_entity_id)))}
              >
                Select all {rows.length}
              </button>
              <button
                className="rounded border border-border px-2 py-0.5 hover:bg-muted"
                onClick={() =>
                  setPicked(
                    new Set(
                      rows.filter((r) => Number(r.confidence) >= 0.9).map((r) => r.ad_entity_id),
                    ),
                  )
                }
              >
                Select the strongest matches
              </button>
              <button
                className="rounded border border-border px-2 py-0.5 disabled:opacity-40 hover:bg-muted"
                disabled={picked.size === 0 || decide.isPending}
                onClick={() =>
                  decide.mutate({ adEntityIds: [...picked], confirm: true })
                }
              >
                Confirm {picked.size} selected
              </button>
              <button
                className="rounded border border-border px-2 py-0.5 text-muted-foreground disabled:opacity-40 hover:bg-muted"
                disabled={picked.size === 0 || decide.isPending}
                onClick={() => decide.mutate({ adEntityIds: [...picked], confirm: false })}
              >
                Reject {picked.size} selected
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                    <th className="w-8" />
                    <th className="text-left">Ad</th>
                    <th className="text-left">Proposed script</th>
                    <th className="text-left">Matched on</th>
                    <th className="text-right">Confidence</th>
                    <th className="text-right">Spend 30d</th>
                    <th className="text-left">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.ad_entity_id}
                      className="border-border [&>td]:border-b [&>td]:px-3 [&>td]:py-1.5"
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={picked.has(r.ad_entity_id)}
                          onChange={() => toggle(r.ad_entity_id)}
                        />
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <Thumb url={r.thumbnail_url} />
                          <span className="max-w-[20rem] truncate">
                            {r.ad_name ?? r.ad_entity_id}
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="font-semibold">{r.title ?? r.script_code}</span>
                        <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                          {r.script_code}
                        </span>
                      </td>
                      <td className="text-muted-foreground">{r.basis}</td>
                      <td className="text-right tabular-nums">
                        {Number(r.confidence).toFixed(2)}
                      </td>
                      <td className="text-right tabular-nums">{formatINR(Number(r.spend_30d))}</td>
                      <td>
                        <AdLinks
                          accountId={r.account_id}
                          entityId={r.ad_entity_id}
                          permalink={r.permalink_url}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tags.length > 0 ? (
          <div className="mt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">
                {tags.length} script description{tags.length === 1 ? "" : "s"} written by the machine
                are also waiting — story, hook and persona.
              </p>
              <button
                className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted"
                disabled={confirmTags.isPending}
                onClick={() => confirmTags.mutate(tags.map((t) => t.script_id))}
              >
                Confirm all {tags.length}
              </button>
            </div>
            <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
              {tags.map((t) => (
                <li key={t.script_id}>
                  <span className="font-medium text-foreground">{t.title ?? t.script_code}</span>{" "}
                  — {plainConcept(t.persona, t.pain, t.promise)}, opening with{" "}
                  {plainHook(t.hook_mechanism).toLowerCase()}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}
