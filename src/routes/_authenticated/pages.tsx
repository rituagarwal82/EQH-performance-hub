import { useQuery } from "@tanstack/react-query";
import { UiError, RouteError } from "@/components/UiError";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { SectionUnavailable } from "@/components/DataOutage";
import { Disclosure } from "@/components/Disclosure";
import { RangeBar } from "@/components/RangeBar";
import { useDensityMode } from "@/components/DensityProvider";
import { count } from "@/lib/counts";
import { resolveRange } from "@/lib/date-range";
import { NO_DATA } from "@/lib/format";
import { getLandingPageRollup } from "@/lib/pages.functions";
import { validateRangeSearch } from "@/lib/range-search";
import { BRIEF_ROWS } from "@/lib/view-prefs";

export const Route = createFileRoute("/_authenticated/pages")({
  validateSearch: validateRangeSearch,
  head: () => ({
    meta: [
      { title: "Landing pages — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Registrations by landing page for Energy Queens Hub. No page-view source is connected, so a registration rate is not computable and is never guessed.",
      },
      { property: "og:title", content: "Landing pages — EQH Performance Engine" },
      {
        property: "og:description",
        content: "Registrations grouped by landing page, with the missing page-view source named.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PagesPage,
    errorComponent: ({ error, reset }) => (
    <RouteError error={error} reset={reset} subject="the pages view" where="src/routes/pages.tsx" />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

function PagesPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/pages" });
  const range = resolveRange(search.range, { since: search.since, until: search.until });
  const { brief } = useDensityMode();

  const [seeAll, setSeeAll] = useState(false);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["landing-pages", range.since, range.until],
    queryFn: () => getLandingPageRollup({ data: { since: range.since, until: range.until } }),
  });

  // A failed read is not an empty result: `rows` is only trustworthy when the
  // query actually answered.
  const readFailed = isError || Boolean(data?.error);
  const rows = readFailed ? [] : (data?.rows ?? []);
  const shown = brief && !seeAll ? rows.slice(0, BRIEF_ROWS) : rows;
  const shownLeads = shown.reduce((a, r) => a + (Number(r.leads) || 0), 0);
  const shownRegistered = shown.reduce((a, r) => a + (Number(r.registered) || 0), 0);
  const totalLeads = rows.reduce((a, r) => a + (Number(r.leads) || 0), 0);
  const totalRegistered = rows.reduce((a, r) => a + (Number(r.registered) || 0), 0);
  const partial = shown.length < rows.length;

  return (
    <AppShell
      topBar={
        <RangeBar
          title="Landing pages"
          search={search}
          range={range}
          onChange={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
        />
      }
    >
      <div className="space-y-4 px-6 py-5">
        <section className="border-border bg-card rounded-md border">
          <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Registrations by landing page
            </h2>
            <span className="text-[11px] text-muted-foreground">
              counts only — a registration rate needs a page-view source, and none is connected
            </span>
          </div>

          <div className="overflow-x-auto">
            {isLoading ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading…</p>
            ) : readFailed ? (
              <SectionUnavailable
                title="Registrations by landing page"
                detail={error instanceof Error ? error.message : (data?.error ?? null)}
                className="m-4"
              />
            ) : rows.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
                {NO_DATA} — no lead record in this window carries a landing page or a campaign name,
                so not even a registration count by page exists. This is an absence of data, not a
                quiet zero.
              </p>
            ) : (
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                    <th className="text-left">Landing page or campaign</th>
                    <th className="text-left">Recorded as</th>
                    <th className="text-right">Leads</th>
                    <th className="text-right">Registrations</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr
                      key={`${r.key_kind}:${r.page_key}`}
                      className="border-border border-b last:border-b-0 [&>td]:px-3 [&>td]:py-1.5"
                    >
                      <td className="max-w-[520px] truncate" title={r.page_key}>
                        {r.page_key}
                      </td>
                      <td className="text-[11px] text-muted-foreground">
                        {r.key_kind === "landing_page"
                          ? "landing page"
                          : r.key_kind === "utm_campaign"
                            ? "campaign (no page recorded)"
                            : "nothing recorded"}
                      </td>
                      <td className="nums text-right">{count(Number(r.leads) || 0)}</td>
                      <td className="nums text-right">{count(Number(r.registered) || 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {readFailed ? null : (
            <div className="border-border flex flex-wrap items-center gap-2 border-t px-4 py-2 text-[11px] leading-snug text-muted-foreground">
              <span>
                Showing {count(shown.length)} of {count(rows.length)} pages · {range.since} →{" "}
                {range.until} · {count(shownLeads)} leads and {count(shownRegistered)} registrations
                on the rows shown
                {partial
                  ? ` (${count(totalLeads)} leads and ${count(totalRegistered)} registrations across all pages)`
                  : ""}
                . Leads with no page and no campaign recorded are grouped as “nothing recorded”,
                never dropped.
              </span>
              {partial ? (
                <button
                  type="button"
                  onClick={() => setSeeAll(true)}
                  className="ml-auto underline underline-offset-4 hover:text-foreground"
                >
                  See all {count(rows.length)}
                </button>
              ) : null}
            </div>
          )}
        </section>

        <Disclosure
          title="Why there is no registration rate"
          teaser="what is missing, and what would make the rate computable"
        >
          <div className="space-y-2 text-[12px] leading-relaxed">
            <p>
              A registration rate is registrations divided by page views. No page-view source is
              connected to this engine, so the denominator does not exist. Rather than divide by
              something invented, the rate is simply absent from this screen.
            </p>
            <p>
              {data && !data.hasLandingPage
                ? "No lead record currently carries a landing page value, so registrations above are grouped by campaign instead."
                : "Some lead records carry a landing page value; the rest are grouped by campaign."}{" "}
              Connecting a page-view source (site analytics or the page host itself) is the single
              change that would make a rate, and a cost per page view, computable here.
            </p>
            <p className="text-muted-foreground">
              Feed states for the lead source live on{" "}
              <Link to="/health" className="underline underline-offset-4 hover:text-foreground">
                Feed Health
              </Link>
              .
            </p>
          </div>
        </Disclosure>

        {readFailed ? (
          <UiError
            detail={error instanceof Error ? error.message : (data?.error ?? null)}
            subject="the landing page figures"
            where={"src/routes/pages.tsx"}
          />
        ) : null}
      </div>
    </AppShell>
  );
}
