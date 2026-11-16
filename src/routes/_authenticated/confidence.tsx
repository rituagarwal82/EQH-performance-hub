import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";

import { AppShell } from "@/components/AppShell";
import { RouteError, UiError } from "@/components/UiError";
import { Button } from "@/components/ui/button";
import { getOwnerTrust } from "@/lib/owner-trust.functions";
import { resolveReviewItem } from "@/lib/concepts.functions";

const trustQuery = () =>
  queryOptions({ queryKey: ["owner-trust"], queryFn: () => getOwnerTrust() });

export const Route = createFileRoute("/_authenticated/confidence")({
  loader: ({ context }) => context.queryClient.ensureQueryData(trustQuery()),
  head: () => ({
    meta: [
      { title: "Can I trust the numbers? — EQH Performance Engine" },
      {
        name: "description",
        content:
          "One plain answer on whether today's Energy Queens Hub figures can be trusted, the decisions waiting for the owner, and dated risks ahead.",
      },
      { property: "og:title", content: "Can I trust the numbers? — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "Green, amber or red in one line — plus the decisions only the owner can make and what is coming up.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ConfidencePage,
  errorComponent: ({ error, reset }) => (
    <RouteError
      error={error}
      reset={reset}
      subject="the trust answer"
      where="src/routes/confidence.tsx"
    />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

const TONE = {
  green: "border-positive/40 bg-positive/10 text-foreground",
  amber: "border-warning/40 bg-warning/10 text-foreground",
  red: "border-destructive/40 bg-destructive/10 text-foreground",
} as const;

const DOT = {
  green: "bg-positive",
  amber: "bg-warning",
  red: "bg-destructive",
} as const;

// Draft ad scripts are HELD until the angle library and the ideal-client
// evidence exist. Nothing generated before that evidence is shown here.


function ConfidencePage() {
  const { data } = useSuspenseQuery(trustQuery());
  const qc = useQueryClient();
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null);

  const answer = useMutation({
    mutationFn: (vars: { id: string; confirm: boolean }) => resolveReviewItem({ data: vars }),
    onSuccess: (res) => {
      setSaved(
        res.error
          ? { ok: false, text: "That answer was not saved. Please try again." }
          : { ok: true, text: res.applied ?? "Answer saved." },
      );
      void qc.invalidateQueries({ queryKey: ["owner-trust"] });
      void qc.invalidateQueries({ queryKey: ["review"] });
    },
    onError: () => setSaved({ ok: false, text: "That answer was not saved. Please try again." }),
  });


  return (
    <AppShell
      topBar={
        <div className="flex w-full items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-tight">Can I trust the numbers?</h1>
          <span className="text-[11px] text-muted-foreground">
            {data.checksRun} checks run behind this page
          </span>
        </div>
      }
    >
      <div className="mx-auto max-w-3xl px-6 py-6">
        {data.error ? (
          <UiError
            detail={data.error}
            subject="the checks"
            where="src/routes/confidence.tsx"
            className="border-destructive/40 bg-destructive/10 mb-5 rounded-md border px-4 py-3"
          />
        ) : null}

        <section className={`rounded-md border px-4 py-4 ${TONE[data.status]}`}>
          <div className="flex items-start gap-3">
            <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${DOT[data.status]}`} />
            <p className="text-[15px] font-medium leading-relaxed">{data.statusLine}</p>
          </div>
          {data.attention.length > 1 ? (
            <ul className="mt-3 space-y-1.5 pl-6 text-[13px] leading-relaxed">
              {data.attention.map((a) => (
                <li key={a.key} className="list-disc">
                  {a.text}
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="mt-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Decisions waiting for you
          </h2>
          {saved ? (
            <p
              role="status"
              className={`mt-1 text-[12px] font-medium ${saved.ok ? "text-positive" : "text-destructive"}`}
            >
              {saved.text}
            </p>
          ) : null}
          {data.decisions.length === 0 ? (
            <p className="border-border bg-card mt-2 rounded-md border px-4 py-3 text-[13px] text-muted-foreground">
              Nothing is waiting for you.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {data.decisions.map((d) => (
                <li key={d.key} className="border-border bg-card rounded-md border px-4 py-3">
                  <p className="text-[13px] font-medium">{d.title}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
                    {d.sentence}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    {d.control === "yes_no" && d.id ? (
                      <>
                        <Button
                          size="sm"
                          className="h-7 text-[12px]"
                          disabled={answer.isPending}
                          onClick={() => answer.mutate({ id: d.id as string, confirm: true })}
                        >
                          Yes
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[12px]"
                          disabled={answer.isPending}
                          onClick={() => answer.mutate({ id: d.id as string, confirm: false })}
                        >
                          No
                        </Button>
                      </>
                    ) : (
                      <Link
                        to={d.href ?? "/queue"}
                        className="text-primary text-[12px] font-medium underline underline-offset-2"
                      >
                        Open the list
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Coming up
          </h2>
          {data.upcoming.length === 0 ? (
            <p className="border-border bg-card mt-2 rounded-md border px-4 py-3 text-[13px] text-muted-foreground">
              Nothing dated is due in the next six weeks.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {data.upcoming.map((u) => (
                <li
                  key={u.key}
                  className="border-warning/40 bg-warning/10 rounded-md border px-4 py-3 text-[13px] leading-relaxed"
                >
                  {u.text}
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-6 text-[12px] leading-relaxed text-muted-foreground">
          Every check still runs in full. The detailed screens behind this page — feed health, data
          trust and the full review list — are under{" "}
          <span className="font-medium text-foreground">For the builder</span> at the bottom of the
          menu.
        </p>
      </div>
    </AppShell>
  );
}
