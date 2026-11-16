import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fragment, useMemo, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { RangeBar } from "@/components/RangeBar";
import { UiError, RouteError } from "@/components/UiError";
import { resolveRange } from "@/lib/date-range";
import { formatINR, formatInt, NO_DATA } from "@/lib/format";
import { validateRangeSearch } from "@/lib/range-search";
import {
  getSourceDisagreements,
  getSourceMatrix,
  type SourceRow,
} from "@/lib/sources.functions";

export const Route = createFileRoute("/_authenticated/sources")({
  validateSearch: validateRangeSearch,
  head: () => ({
    meta: [
      { title: "Sources — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Where Energy Queens Hub buyers actually come from: months by channel, with sales and cash per source, first-touch only.",
      },
      { property: "og:title", content: "Sources — EQH Performance Engine" },
      {
        property: "og:description",
        content: "Months by channel, with sales and cash per source, first-touch only.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SourcesPage,
  errorComponent: ({ error, reset }) => (
    <RouteError
      error={error}
      reset={reset}
      subject="the sources view"
      where="src/routes/_authenticated/sources.tsx"
    />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

const ERA_NOTES: Record<string, string> = {
  "ScaleX (agency, closed)": "Closed agency era — no campaign detail, costs not in the system.",
  "Tushar (agency, closed)": "Past ad agency, closed — costs not in the system.",
  "Sabhi Digital – Google Ads":
    "Google Ads was run by Sabhi Digital and stopped 26 Aug 2026. Its cost was never recorded here, so no return can be worked out for that period.",
  Collaboration:
    "free collaboration — not a sale. These people joined free through another coach, so they count as leads only; a sale appears here only if that person later paid for something.",
  "Organic search": "No media cost — old links and search traffic.",
  "No source recorded": "The first record for these people carried no source we can trust.",
  "Old database (before tracking)": "imported history — original source was never captured",
  "Meta ads – account unknown":
    "Meta leads whose ad account could not be identified — not merged into any agency.",
};

const META_ALL = "Meta ads (all)";
const isMeta = (c: string) => c.includes("Meta ads");


function num(v: number | string | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function SourcesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/sources" });
  const range = resolveRange(search.range, { since: search.since, until: search.until });
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["sources", range.since, range.until],
    queryFn: () => getSourceMatrix({ data: { since: range.since, until: range.until } }),
  });

  const disagree = useQuery({
    queryKey: ["source-disagreements", range.since, range.until],
    queryFn: () => getSourceDisagreements({ data: { since: range.since, until: range.until } }),
  });
  const disagreeRows = disagree.data?.error ? [] : (disagree.data?.rows ?? []);

  const readFailed = isError || Boolean(data?.error);
  const rows: SourceRow[] = readFailed ? [] : (data?.rows ?? []);

  const months = useMemo(
    () => Array.from(new Set(rows.map((r) => r.month))).sort().reverse(),
    [rows],
  );
  const channels = useMemo(() => {
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.channel, (totals.get(r.channel) ?? 0) + num(r.cash));
    const ordered = Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => c);
    const meta = ordered.filter(isMeta);
    if (meta.length === 0) return ordered;
    // Meta is never one bucket: each agency keeps its own row, with a subtotal above them.
    const out: string[] = [];
    let inserted = false;
    for (const c of ordered) {
      if (isMeta(c)) {
        if (!inserted) {
          out.push(META_ALL, ...meta);
          inserted = true;
        }
        continue;
      }
      out.push(c);
    }
    return out;

  }, [rows]);

  const cell = (channel: string, month: string) => {
    const inCell = rows.filter(
      (r) => r.month === month && (channel === META_ALL ? isMeta(r.channel) : r.channel === channel),
    );
    return {
      sales: inCell.reduce((s, r) => s + num(r.sales_paid), 0),
      cash: inCell.reduce((s, r) => s + num(r.cash), 0),
      inferred: inCell.some((r) => r.confidence === "inferred"),
    };
  };


  return (
    <AppShell
      topBar={
        <RangeBar
          title="Sources"
          search={search}
          range={range}
          onChange={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
        />
      }
    >
      <div className="space-y-6 px-6 py-5">
      {readFailed ? (
        <UiError
          detail={error instanceof Error ? error.message : (data?.error ?? null)}
          subject="the sources view"
          where="src/routes/_authenticated/sources.tsx"
        />
      ) : isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{NO_DATA}</p>
      ) : (
        <div className="space-y-6">
          <p className="text-sm text-muted-foreground">
            One source per person. A later re-registration or a sales campaign never replaces the
            source they first arrived through. “Inferred” means the source came from a tag rather
            than a link, so treat it as a strong hint, not a fact.
          </p>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm tabular-nums">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  {months.map((m) => (
                    <th key={m} className="px-3 py-2 text-right font-medium">
                      {m}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <Fragment key={c}>
                    <tr
                      className="cursor-pointer border-t border-border hover:bg-muted/40"
                      onClick={() => c !== META_ALL && setOpen(open === c ? null : c)}
                    >
                      <td className={`px-3 py-2 ${isMeta(c) && c !== META_ALL ? "pl-6" : ""}`}>
                        <span className="font-medium">{c}</span>
                        {(() => {
                          const note =
                            ERA_NOTES[c] ??
                            (c.startsWith("Meta ads – ") && c !== "Meta ads – account unknown"
                              ? "Ad account named, agency not confirmed yet — tell us who runs it and we will label it."
                              : c === META_ALL
                                ? "Subtotal of every Meta agency row below."
                                : null);
                          return note ? (
                            <span className="ml-2 text-xs text-muted-foreground">{note}</span>
                          ) : null;
                        })()}
                      </td>

                      {months.map((m) => {
                        const v = cell(c, m);
                        return (
                          <td key={m} className="px-3 py-2 text-right">
                            <div>{v.sales === 0 ? "—" : `${formatInt(v.sales)} sales`}</div>
                            <div className="text-xs text-muted-foreground">
                              {v.cash === 0 ? "" : formatINR(v.cash)}
                              {v.inferred ? " · inferred" : ""}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                    {open === c
                      ? Array.from(new Set(rows.filter((r) => r.channel === c).map((r) => r.source)))
                          .map((src) => (
                            <tr key={`${c}-${src}`} className="border-t border-border/50 bg-muted/20">
                              <td className="px-3 py-1.5 pl-8 text-muted-foreground">
                                {src}
                                {(() => {
                                  const tools = Array.from(
                                    new Set(
                                      rows
                                        .filter((r) => r.channel === c && r.source === src && r.tool)
                                        .map((r) => r.tool as string),
                                    ),
                                  );
                                  return tools.length > 0 ? (
                                    <span className="ml-2 text-xs">via {tools.join(", ")}</span>
                                  ) : null;
                                })()}
                                {rows.some(
                                  (r) => r.source === src && r.confidence === "inferred",
                                ) ? (
                                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs">
                                    inferred
                                  </span>
                                ) : null}
                              </td>
                              {months.map((m) => {
                                const r = rows.find((x) => x.source === src && x.month === m);
                                return (
                                  <td key={m} className="px-3 py-1.5 text-right text-xs">
                                    <div>
                                      {r && num(r.sales_paid) > 0
                                        ? `${formatInt(r.sales_paid)} sales`
                                        : "—"}
                                    </div>
                                    <div className="text-muted-foreground">
                                      {r && num(r.leads) > 0 ? `${formatInt(r.leads)} leads` : ""}
                                      {r && num(r.cash) > 0 ? ` · ${formatINR(r.cash)}` : ""}
                                    </div>
                                  </td>
                                );
                              })}
                            </tr>
                          ))
                      : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            Sales are counted on the fully-paid basis (a seat deposit only becomes a sale once it is
            paid in full). Cash is what the accounts ledger recorded in the month. Where tracking
            found nothing, the accounts team's own source entry fills the gap and is marked
            “team-confirmed”.
          </p>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">
              Team disagrees — needs review
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {disagree.isError || disagree.data?.error
                  ? "list unreadable"
                  : disagree.isLoading
                    ? "still reading"
                    : `${formatInt(disagreeRows.length)} sale${disagreeRows.length === 1 ? "" : "s"}`}
              </span>
            </h2>
            <p className="text-xs text-muted-foreground">
              Tracking has hard evidence for these buyers and the accounts team wrote down a
              different source. Tracking's answer is the one used in the table above; these are
              listed so someone can settle them.
            </p>
            {disagree.isError || disagree.data?.error ? (
              <UiError
                detail={
                  disagree.error instanceof Error
                    ? disagree.error.message
                    : (disagree.data?.error ?? null)
                }
                subject="the disagreement list"
                where="src/routes/_authenticated/sources.tsx"
              />
            ) : disagreeRows.length === 0 && !disagree.isLoading ? (
              <p className="text-sm text-muted-foreground">No disagreements in this period.</p>
            ) : (
              <div className="max-h-96 overflow-auto rounded-lg border border-border">
                <table className="w-full text-sm tabular-nums">
                  <thead className="sticky top-0 bg-muted/50 text-left">
                    <tr>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Buyer</th>
                      <th className="px-3 py-2 font-medium">Tracking says</th>
                      <th className="px-3 py-2 font-medium">Team says</th>
                      <th className="px-3 py-2 font-medium">Evidence</th>
                      <th className="px-3 py-2 text-right font-medium">Cash</th>
                    </tr>
                  </thead>
                  <tbody>
                    {disagreeRows.map((r) => (
                      <tr key={r.sale_id} className="border-t border-border">
                        <td className="px-3 py-1.5">{r.business_date}</td>
                        <td className="px-3 py-1.5">{r.email ?? NO_DATA}</td>
                        <td className="px-3 py-1.5">{r.tracking_answer}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{r.team_answer}</td>
                        <td className="px-3 py-1.5 text-xs text-muted-foreground">
                          {r.evidence ?? NO_DATA}
                        </td>
                        <td className="px-3 py-1.5 text-right">{formatINR(num(r.cash))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
      </div>
    </AppShell>
  );
}
