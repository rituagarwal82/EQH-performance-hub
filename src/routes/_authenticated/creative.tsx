import { uiMessage } from "@/lib/error-copy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UiError, RouteError } from "@/components/UiError";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AdPerformanceTable } from "@/components/AdPerformanceTable";
import { AdLinks, ScriptProposals, Thumb } from "@/components/ScriptProposals";
import { getScriptProposals } from "@/lib/script-proposals.functions";
import { AppShell } from "@/components/AppShell";
import { ConceptLedger } from "@/components/ConceptLedger";
import { SectionUnavailable } from "@/components/DataOutage";
import { Figure } from "@/components/Figure";
import { Kpi } from "@/components/Kpi";
import { useDensityMode } from "@/components/DensityProvider";
import { MetricValue } from "@/components/MetricValue";
import { RangeBar } from "@/components/RangeBar";
import { count } from "@/lib/counts";
import {
  attachScript,
  getCreativeData,
  resolveMapping,
  type UnmappedAd,
} from "@/lib/creative.functions";
import { getConceptData } from "@/lib/concepts.functions";
import { resolveRange } from "@/lib/date-range";
import { divideMetrics, fromObserved, rate, sumMetrics, unmeasured } from "@/lib/metric";
import { validateRangeSearch } from "@/lib/range-search";

export const Route = createFileRoute("/_authenticated/creative")({
  validateSearch: validateRangeSearch,
  head: () => ({
    meta: [
      { title: "Creative — EQH Performance Engine" },
      {
        name: "description",
        content:
          "The script registry for Energy Queens Hub: which script each ad carries, the spend behind it, its registrations, attendance and cost per 60-minute attendee, plus the ads still carrying no script.",
      },
      { property: "og:title", content: "Creative — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "Script-level creative performance with the unmapped-ad coverage gap stated in full.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CreativePage,
    errorComponent: ({ error, reset }) => (
    <RouteError error={error} reset={reset} subject="the creative view" where="src/routes/creative.tsx" />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

function CreativePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/creative" });
  const range = resolveRange(search.range, { since: search.since, until: search.until });
  const qc = useQueryClient();
  const { brief } = useDensityMode();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["creative", range.since, range.until],
    queryFn: () => getCreativeData({ data: { since: range.since, until: range.until } }),
  });

  const { data: conceptData, isError: conceptFailed } = useQuery({
    queryKey: ["concepts", range.since, range.until],
    queryFn: () => getConceptData({ data: { since: range.since, until: range.until } }),
  });

  // One example ad per script, so every script row can be watched and opened.
  const { data: proposalData } = useQuery({
    queryKey: ["script-proposals"],
    queryFn: () => getScriptProposals(),
  });
  const exampleByScript = new Map(
    (proposalData?.examples ?? []).map((e) => [e.script_id, e] as const),
  );

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["creative"] });

  const resolve = useMutation({
    mutationFn: (vars: { adEntityId: string; confirm: boolean }) => resolveMapping({ data: vars }),
    onSuccess: invalidate,
  });

  // P0-C: a failed or in-flight read must never be summed into a confident 0.
  // A THROWN query leaves `data` undefined, so keying off data.error alone
  // silently turned a failed read back into a confident empty screen.
  const readFailed = isError || Boolean(data?.error);
  const readDetail = error instanceof Error ? error.message : (data?.error ?? null);
  const readAnswered = Boolean(data) && !readFailed;
  const unread = "the creative read did not answer";
  const registry = readFailed ? [] : (data?.registry ?? []);
  const unmapped = readFailed ? [] : (data?.unmapped ?? []);
  const queue = readFailed ? [] : (data?.queue ?? []);
  const cov = readFailed ? undefined : data?.coverage;

  const totalAds = registry.reduce((a, r) => a + (Number(r.ads_mapped) || 0), 0);
  const totalSpend = readAnswered
    ? sumMetrics(registry.map((r) => fromObserved(r.spend)))
    : unmeasured(unread);
  const totalLeads = readAnswered
    ? sumMetrics(registry.map((r) => fromObserved(r.tracked_leads)))
    : unmeasured(unread);
  const totalCpl = divideMetrics(totalSpend, totalLeads);

  const coverageLine = cov
    ? `${count(Number(cov.with_body))} of ${count(Number(cov.ads_total))} ads carry creative text · ${count(
        Number(cov.with_title),
      )} carry a headline · ${count(Number(cov.fetch_failed))} failed to fetch · ${count(
        Number(cov.never_fetched),
      )} never fetched`
    : "creative text coverage not yet measured";

  return (
    <AppShell
      topBar={
        <RangeBar
          title="Creative"
          search={search}
          range={range}
          onChange={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
        />
      }
    >
      <div className="space-y-4 px-6 py-5">
        <p className="text-[12px] font-medium">
          Ads shows how each ad performs; Creative shows which story, hook and persona is working
          across the ads carrying it.
        </p>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {readAnswered
            ? `${count(registry.length)} scripts carried ${count(totalAds)} ads in this window.`
            : "How many scripts ran in this window could not be read."}{" "}
          Anything
          sales-adjacent is concept-level only — per-ad rows carry click rate and cost per
          registration and nothing further.
        </p>

        <section className="border-border bg-card grid grid-cols-2 rounded-md border md:grid-cols-4">
          <Kpi
            label="Scripts running"
            metric={readAnswered ? fromObserved(registry.length) : unmeasured(unread)}
            format="int"
          />
          <Kpi label="Spend on scripted ads" metric={totalSpend} format="inr" />
          <Kpi label="Registrations" metric={totalLeads} format="int" />
          <Kpi
            label="Cost per registration"
            metric={totalCpl}
            format="inr"
            contract="cost_per_registration"
          />
        </section>

        {readFailed ? (
          <div className="border-destructive/40 bg-destructive/10 rounded border px-3 py-2 text-[12px] text-destructive">
            <UiError
              detail={readDetail}
              subject="the creative figures"
              where={"src/routes/creative.tsx"}
            />
          </div>
        ) : null}

        <ScriptProposals />

        <div className="border-border bg-muted/40 rounded border px-3 py-2 text-[11px] text-muted-foreground">
          {readFailed ? "Coverage could not be read for this window." : coverageLine}
        </div>

        <AdPerformanceTable days={14} />

        {conceptFailed ? (
          <SectionUnavailable title="Concepts" />
        ) : conceptData ? (
          <ConceptLedger data={conceptData} />
        ) : null}

        <Figure
          id="creative-registry"
          title="Script registry"
          n={`${count(registry.length)} scripts`}
          window={`${range.since} → ${range.until}`}
          excluded="rates suppressed below n=30; attendance joins leads to Zoom by email, so untracked leads are absent rather than counted as no-shows"
          table={
            registry.length === 0 ? (
              <Empty
                text={
                  isLoading
                    ? "Loading…"
                    : readFailed
                      ? "The script registry could not be read — this is not an empty registry."
                      : "No scripts in the registry yet — paste one against an unmapped ad below."
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                      <th className="text-left">Script</th>
                      <th className="text-left">Open</th>
                      <th className="text-right">Ads</th>
                      <th className="text-right">Spend</th>
                      <th className="text-right">Leads</th>
                      <th className="text-right">CPL</th>
                      <th className="text-right">Attendance</th>
                      <th className="text-right">60-min</th>
                      <th className="text-right">Cost / 60-min</th>
                    </tr>
                  </thead>
                  <tbody>
                    {registry.map((r) => {
                      const spend = fromObserved(r.spend);
                      const leads = fromObserved(r.tracked_leads);
                      const attendees = fromObserved(r.attendees);
                      const a60 = fromObserved(r.attendees_60);
                      const example = exampleByScript.get(r.script_id);
                      return (
                        <tr
                          key={r.script_id}
                          className="border-border [&>td]:border-b [&>td]:px-3 [&>td]:py-1.5"
                        >
                          <td>
                            <div className="flex items-center gap-2">
                              <Thumb url={example?.thumbnail_url ?? null} />
                              <span>
                                <span className="font-semibold">{r.title ?? r.script_code}</span>
                                <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                                  {r.script_code}
                                </span>
                                {Number(r.low_conf_ads) > 0 ? (
                                  <span className="ml-2 rounded bg-warning/20 px-1 text-[10px] text-warning-foreground">
                                    {count(Number(r.low_conf_ads))} unconfirmed
                                  </span>
                                ) : null}
                              </span>
                            </div>
                          </td>
                          <td>
                            {example ? (
                              <AdLinks
                                accountId={example.account_id}
                                entityId={example.entity_id}
                                permalink={example.permalink_url}
                              />
                            ) : (
                              <span className="text-[11px] text-muted-foreground">
                                no ad recorded
                              </span>
                            )}
                          </td>
                          <td className="text-right tabular-nums">{count(Number(r.ads_mapped))}</td>
                          <td className="text-right tabular-nums">
                            <MetricValue metric={spend} format="inr" />
                          </td>
                          <td className="text-right tabular-nums">
                            <MetricValue metric={leads} />
                          </td>
                          <td className="text-right tabular-nums">
                            <MetricValue metric={divideMetrics(spend, leads)} format="inr" />
                          </td>
                          <td className="text-right tabular-nums">
                            <MetricValue metric={rate(attendees, leads)} format="percent" />
                          </td>
                          <td className="text-right tabular-nums">
                            <MetricValue metric={rate(a60, attendees)} format="percent" />
                          </td>
                          <td className="text-right tabular-nums">
                            <MetricValue metric={divideMetrics(spend, a60)} format="inr" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          }
        />

        {brief ? null : (
          <Figure
            id="creative-queue"
            title="Script mapping review"
            note="auto matches below 0.8 confidence — nothing here is counted as settled"
            n={`${count(queue.length)} awaiting confirmation`}
            window="all time"
            excluded="high-confidence code matches are applied directly and do not appear here"
            table={
              queue.length === 0 ? (
                <Empty
                text={
                  readFailed
                    ? "This list could not be read — it is not empty."
                    : "Nothing awaiting confirmation."
                }
              />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                        <th className="text-left">Ad</th>
                        <th className="text-left">Proposed script</th>
                        <th className="text-right">Confidence</th>
                        <th className="text-right">Spend 30d</th>
                        <th className="text-right">Decide</th>
                      </tr>
                    </thead>
                    <tbody>
                      {queue.map((q) => (
                        <tr
                          key={q.ad_entity_id}
                          className="border-border [&>td]:border-b [&>td]:px-3 [&>td]:py-1.5"
                        >
                          <td className="max-w-[380px] truncate">{q.ad_name ?? q.ad_entity_id}</td>
                          <td>
                            <span>{q.title ?? q.script_code}</span>
                            <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                              {q.script_code}
                            </span>
                          </td>
                          <td className="text-right tabular-nums">
                            {Number(q.confidence).toFixed(2)}
                          </td>
                          <td className="text-right tabular-nums">
                            <MetricValue metric={fromObserved(q.spend_30d)} format="inr" />
                          </td>
                          <td className="text-right">
                            <button
                              className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted"
                              disabled={resolve.isPending}
                              onClick={() =>
                                resolve.mutate({ adEntityId: q.ad_entity_id, confirm: true })
                              }
                            >
                              Confirm
                            </button>
                            <button
                              className="ml-1 rounded border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted"
                              disabled={resolve.isPending}
                              onClick={() =>
                                resolve.mutate({ adEntityId: q.ad_entity_id, confirm: false })
                              }
                            >
                              Reject
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            }
          />
        )}

        {brief ? null : (
          <Figure
            id="creative-unmapped"
            title="Unmapped ads"
            note="spent in the last 30 days and carry no script"
            n={`${count(unmapped.length)} ads`}
            window="last 30 days"
            excluded="ads with no spend in the window are not listed"
            table={
              unmapped.length === 0 ? (
                <Empty
                text={
                  readFailed
                    ? "This list could not be read, so we cannot say whether every ad carries a script."
                    : "Every ad that spent in the last 30 days carries a script."
                }
              />
              ) : (
                <div className="divide-border divide-y">
                  {unmapped.map((ad) => (
                    <AttachRow
                      key={ad.entity_id}
                      ad={ad}
                      scripts={data?.scripts ?? []}
                      onDone={invalidate}
                    />
                  ))}
                </div>
              )
            }
          />
        )}
      </div>
    </AppShell>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-6 text-[12px] text-muted-foreground">{text}</div>;
}

/** Paste-box per ad: pick an existing script, or paste a new one with a code. */
function AttachRow({
  ad,
  scripts,
  onDone,
}: {
  ad: UnmappedAd;
  scripts: { id: string; script_code: string; title: string | null }[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [scriptId, setScriptId] = useState("");
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      attachScript({
        data: scriptId
          ? { adEntityId: ad.entity_id, scriptId }
          : {
              adEntityId: ad.entity_id,
              scriptCode: code.trim(),
              title: title.trim() || undefined,
              scriptText: text,
            },
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setOpen(false);
        onDone();
      } else setError(res.error);
    },
    onError: (e: Error) => setError(uiMessage(e, "attaching the script")),
  });

  return (
    <div className="px-4 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-3">
        <Thumb url={ad.thumbnail_url} />
        <span className="min-w-0 flex-1 truncate">{ad.ad_name ?? ad.entity_id}</span>
        <AdLinks accountId={ad.account_id} entityId={ad.entity_id} permalink={null} />
        <span className="tabular-nums text-muted-foreground">
          <MetricValue metric={fromObserved(ad.spend)} format="inr" /> ·{" "}
          <MetricValue metric={fromObserved(ad.leads)} /> leads
        </span>
        <button
          className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Cancel" : "Attach script"}
        </button>
      </div>

      {ad.creative_body ? (
        <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{ad.creative_body}</p>
      ) : null}

      {open ? (
        <div className="mt-2 space-y-2 rounded border border-border bg-muted/30 p-3">
          <label className="block text-[11px] text-muted-foreground">
            Existing script
            <select
              className="mt-1 block w-full rounded border border-border bg-background px-2 py-1 text-[12px]"
              value={scriptId}
              onChange={(e) => setScriptId(e.target.value)}
            >
              <option value="">— paste a new one below —</option>
              {scripts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.script_code}
                  {s.title ? ` — ${s.title}` : ""}
                </option>
              ))}
            </select>
          </label>

          {scriptId ? null : (
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className="rounded border border-border bg-background px-2 py-1 text-[12px]"
                placeholder="Script code (e.g. V7)"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <input
                className="rounded border border-border bg-background px-2 py-1 text-[12px]"
                placeholder="Title (optional)"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <textarea
                className="min-h-[90px] rounded border border-border bg-background px-2 py-1 text-[12px] sm:col-span-2"
                placeholder="Paste the script text"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
          )}

          {error ? <p className="text-[11px] text-destructive">{error}</p> : null}

          <button
            className="rounded bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
            disabled={save.isPending || (!scriptId && (!code.trim() || !text.trim()))}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            {save.isPending ? "Saving…" : "Save mapping"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
