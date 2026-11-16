import { DENSITIES, GRAINS, type Density, type Grain } from "@/lib/view-prefs";
import { uiMessage } from "@/lib/error-copy";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { UiError, RouteError } from "@/components/UiError";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { Kpi } from "@/components/Kpi";
import { ReviewQueue } from "@/components/ReviewQueue";
import { RangeBar, type RangeSearch } from "@/components/RangeBar";
import { Input } from "@/components/ui/input";
import { getConceptData } from "@/lib/concepts.functions";
import { resolveRange, type RangePreset } from "@/lib/date-range";
import { NO_DATA } from "@/lib/format";
import {
  classifyNoLeadBuyers,
  getNoLeadBuyers,
  type NoLeadBuyer,
} from "@/lib/attribution.functions";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { MetricValue, type MetricFormat } from "@/components/MetricValue";
import { fromObserved, measured, sumMetrics, unmeasured, type Metric } from "@/lib/metric";

const queueQuery = (since: string, until: string) =>
  queryOptions({
    queryKey: ["nolead-buyers", since, until],
    queryFn: () => getNoLeadBuyers({ data: { since, until } }),
  });

export const Route = createFileRoute("/_authenticated/queue")({
  validateSearch: (search: Record<string, unknown>): RangeSearch => ({
    range: (search["range"] as RangePreset) ?? "last7",
    since: search["since"] as string | undefined,
    until: search["until"] as string | undefined,
    compare: search["compare"] === true,
    ...(typeof search["agency"] === "string" && search["agency"]
      ? { agency: search["agency"] }
      : {}),
    ...((GRAINS as readonly string[]).includes(String(search["grain"]))
      ? { grain: search["grain"] as Grain }
      : {}),
    ...((DENSITIES as readonly string[]).includes(String(search["view"]))
      ? { view: search["view"] as Density }
      : {}),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    const r = resolveRange(deps.range, { since: deps.since, until: deps.until });
    return context.queryClient.ensureQueryData(queueQuery(r.since, r.until));
  },
  head: () => ({
    meta: [
      { title: "Review Queue — EQH Performance Engine" },
      {
        name: "description",
        content:
          "L1 Silver buyers whose email matches no lead record: the population that never entered a tracked funnel, listed with amounts so it is visible rather than merged into an agency's numbers.",
      },
      { property: "og:title", content: "Review Queue — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "Buyers with no lead record — podcast, organic and referral identified by absence, never by a guessed label.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: QueuePage,
  errorComponent: ({ error, reset }) => (
    <RouteError
      error={error}
      reset={reset}
      subject="the review queue"
      where="src/routes/queue.tsx"
    />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

const BUCKET_LABEL: Record<string, string> = {
  phone_match: "Reachable by phone",
  phone_conflict: "Phone points at more than one person",
  predates_lead_history: "Bought before lead history",
  not_in_lead_system: "Not in the lead system at all",
};

const DECISION_LABEL: Record<string, string> = {
  accepted_untracked_source: "Accepted — untracked source",
  needs_owner_lookup: "Marked for owner lookup",
};

function QueuePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const range = resolveRange(search.range, { since: search.since, until: search.until });
  const { data } = useSuspenseQuery(queueQuery(range.since, range.until));
  const [filter, setFilter] = useState("");
  const [bucket, setBucket] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);
  const qc = useQueryClient();
  const review = useQuery({
    queryKey: ["review", range.since, range.until],
    queryFn: () => getConceptData({ data: { since: range.since, until: range.until } }),
  });

  const bucketed = useMemo(
    () => (bucket === "all" ? data.rows : data.rows.filter((r) => r.bucket === bucket)),
    [data.rows, bucket],
  );

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return bucketed;
    return bucketed.filter(
      (r: NoLeadBuyer) =>
        (r.email_raw ?? r.email_key).toLowerCase().includes(q) ||
        (r.payer_name ?? "").toLowerCase().includes(q),
    );
  }, [bucketed, filter]);

  // A failed read has no rows — that is an ABSENCE, not a zero. Every total
  // here stays unmeasured (em dash) unless the read actually answered.
  const readFailed = data.error !== null;
  const totals = useMemo(
    () => ({
      buyers: readFailed
        ? unmeasured("the buyer list could not be read")
        : measured(data.rows.length),
      sales: readFailed
        ? unmeasured("the buyer list could not be read")
        : sumMetrics(data.rows.map((r) => fromObserved(r.sales))),
      collected: readFailed
        ? unmeasured("the buyer list could not be read")
        : sumMetrics(data.rows.map((r) => fromObserved(r.collected))),
    }),
    [data.rows, readFailed],
  );

  const counts: Record<string, number> = readFailed ? {} : (data.summary?.buckets ?? {});
  const chipCount = (k: string) => (readFailed ? "no data" : String(counts[k] ?? 0));
  const historyStart = data.summary?.lead_history_start ?? null;

  async function classify(decision: string) {
    // Act on WHAT IS ON SCREEN. Acting on the whole group while a search box
    // narrowed the table meant a decision was recorded for people the owner
    // could not see.
    if (rows.length === 0) return;
    setBusy(true);
    setSaved(null);
    const res = await classifyNoLeadBuyers({
      data: {
        emails: rows.map((r) => r.email_key),
        bucket,
        decision,
        note: `${range.since} → ${range.until}`,
      },
    });
    setBusy(false);
    // A failure must not look like a confirmation.
    setSaved(
      res.error
        ? { ok: false, text: uiMessage(new Error(res.error), "recording the decision") }
        : { ok: true, text: `Recorded for ${res.written} buyer(s).` },
    );
    if (!res.error) void qc.invalidateQueries({ queryKey: ["nolead-buyers"] });
  }

  return (
    <AppShell
      topBar={
        <RangeBar
          title="Review queue"
          search={search}
          range={range}
          onChange={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
        />
      }
    >
      <div className="space-y-4 px-6 py-4">
        <ReviewQueue
          items={review.data?.review ?? []}
          error={review.data?.error ?? null}
          loading={review.isPending}
        />

        <header className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-base font-semibold tracking-tight">Buyers with no lead record</h1>
          <span className="text-[11px] text-muted-foreground">
            {range.since} → {range.until} · L1 Silver · matched on lowercased, trimmed email
          </span>
        </header>

        {data.error ? (
          <div
            role="alert"
            className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
          >
            <UiError detail={data.error} where={"src/routes/queue.tsx"} />
          </div>
        ) : null}

        <div className="rounded border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          These people bought without ever entering a tracked funnel — podcast, organic and
          word-of-mouth, identified by{" "}
          <span className="font-medium text-foreground">absence of a lead record</span> rather than
          by a guessed label. Email is the first match; a phone number is used only when it points
          at exactly one person. They are counted in revenue and shown here as their own line, never
          credited to paid traffic and never merged into an agency's numbers. Lead history starts{" "}
          <span className="font-medium text-foreground">{historyStart ?? NO_DATA}</span>; anyone who
          bought before that could not have a lead record.
        </div>

        <section className="grid grid-cols-2 gap-2 md:grid-cols-3">
          <Kpi
            variant="card"
            label="Buyers with no lead record"
            metric={totals.buyers}
            format="int"
          />
          <Kpi variant="card" label="Sales" metric={totals.sales} format="int" />
          <Kpi variant="card" label="Collected (gross)" metric={totals.collected} format="inr" />
        </section>

        <div className="flex flex-wrap items-center gap-1.5">
          {[
            { key: "all", label: `All (${readFailed ? "no data" : data.rows.length})` },
            { key: "phone_match", label: `Reachable by phone (${chipCount("phone_match")})` },
            {
              key: "phone_conflict",
              label: `Phone points at more than one person (${chipCount("phone_conflict")})`,
            },
            {
              key: "predates_lead_history",
              label: `Bought before lead history (${chipCount("predates_lead_history")})`,
            },
            {
              key: "not_in_lead_system",
              label: `Not in the lead system at all (${chipCount("not_in_lead_system")})`,
            },
          ].map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setBucket(b.key)}
              className={`rounded border px-2 py-1 text-[11px] ${
                bucket === b.key
                  ? "border-foreground/40 bg-foreground/10 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted/60"
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded border border-border px-3 py-2 text-[11px]">
          <span className="text-muted-foreground">
            Record one decision for the {rows.length} {rows.length === 1 ? "buyer" : "buyers"}{" "}
            listed below
            {rows.length < bucketed.length ? " (your search has narrowed this group)" : ""}. This
            only notes the decision — no figure changes.
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || rows.length === 0}
            onClick={() => void classify("accepted_untracked_source")}
          >
            Accept as untracked source ({rows.length})
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || rows.length === 0}
            onClick={() => void classify("needs_owner_lookup")}
          >
            Mark for owner lookup ({rows.length})
          </Button>
          {saved ? (
            <span className={saved.ok ? "text-muted-foreground" : "font-medium text-destructive"}>
              {saved.text}
            </span>
          ) : null}
        </div>

        <Input
          value={filter}
          placeholder="Filter by email or payer name"
          className="h-8 max-w-xs text-[12px]"
          onChange={(e) => setFilter(e.target.value)}
        />

        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-[12px]">
            <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Email</th>
                <th className="px-3 py-1.5 text-left font-medium">Payer</th>
                <th className="px-3 py-1.5 text-left font-medium">First</th>
                <th className="px-3 py-1.5 text-left font-medium">Last</th>
                <th className="px-3 py-1.5 text-right font-medium">Sales</th>
                <th className="px-3 py-1.5 text-right font-medium">Collected</th>
                <th className="px-3 py-1.5 text-right font-medium">Rows</th>
                <th className="px-3 py-1.5 text-left font-medium">Group</th>
                <th className="px-3 py-1.5 text-left font-medium">Decision</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-2 py-6 text-center text-muted-foreground">
                    {NO_DATA}
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.email_key} className="border-t border-border/60 hover:bg-muted/40">
                    <td className="px-3 py-1 font-mono">{r.email_raw ?? r.email_key}</td>
                    <td className="px-3 py-1">{r.payer_name ?? NO_DATA}</td>
                    <td className="px-3 py-1 font-mono tabular-nums">{r.first_date ?? NO_DATA}</td>
                    <td className="px-3 py-1 font-mono tabular-nums">{r.last_date ?? NO_DATA}</td>
                    <td className="px-3 py-1 text-right font-mono tabular-nums">
                      <MetricValue metric={fromObserved(r.sales)} format="int" />
                    </td>
                    <td className="px-3 py-1 text-right font-mono tabular-nums">
                      <MetricValue metric={fromObserved(r.collected)} format="inr" />
                    </td>
                    <td className="px-3 py-1 text-right font-mono tabular-nums">
                      <MetricValue metric={fromObserved(r.rows_count)} format="int" />
                    </td>
                    <td className="px-3 py-1 text-muted-foreground">
                      {BUCKET_LABEL[r.bucket] ?? r.bucket}
                    </td>
                    <td className="px-3 py-1 text-muted-foreground">
                      {r.decision ? (DECISION_LABEL[r.decision] ?? r.decision) : NO_DATA}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
