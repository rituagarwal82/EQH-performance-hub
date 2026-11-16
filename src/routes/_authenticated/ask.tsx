import { useDensityMode } from "@/components/DensityProvider";
import { uiMessage } from "@/lib/error-copy";
import { useMutation, useQuery } from "@tanstack/react-query";
import { UiError, RouteError } from "@/components/UiError";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { askQuestion, getAskLog, SUGGESTED_QUESTIONS, type AskAnswer } from "@/lib/ask.functions";

export const Route = createFileRoute("/_authenticated/ask")({
  head: () => ({
    meta: [
      { title: "Ask your business — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Ask a plain-language question about spend, registrations, attendance or collections and get an answer read straight out of the Energy Queens Hub database, with the query it ran.",
      },
      { property: "og:title", content: "Ask your business — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "Plain-language questions answered from the database only — every answer shows the SQL and the row count behind it.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AskPage,
  errorComponent: ({ error, reset }) => (
    <RouteError error={error} reset={reset} subject="your question" where="src/routes/ask.tsx" />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

type Turn = { question: string; result: AskAnswer | null; error: string | null };

function AskPage() {
  const { density } = useDensityMode();
  const working = density === "working";
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);

  const ask = useServerFn(askQuestion);
  const logFn = useServerFn(getAskLog);
  const log = useQuery({ queryKey: ["ask-log"], queryFn: () => logFn(), staleTime: 30_000 });

  const run = useMutation({
    mutationFn: (question: string) => ask({ data: { question } }),
    onSuccess: (result) => {
      setTurns((prev) => [{ question: result.question, result, error: null }, ...prev]);
      void log.refetch();
    },
    onError: (error: Error, question) => {
      setTurns((prev) => [
        { question, result: null, error: uiMessage(error, "your question") },
        ...prev,
      ]);
    },
  });

  const submit = (question: string) => {
    const q = question.trim();
    if (!q || run.isPending) return;
    setDraft("");
    run.mutate(q);
  };

  return (
    <AppShell
      topBar={
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-tight">Ask your business</h1>
          <span className="text-[11px] text-muted-foreground">
            Answers come from the database only — nothing is estimated
          </span>
        </div>
      }
    >
      <div className="mx-auto w-full max-w-4xl px-6 py-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(draft);
          }}
          className="border-border bg-card rounded-md border p-3"
        >
          <label htmlFor="ask-input" className="sr-only">
            Your question
          </label>
          <textarea
            id="ask-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            rows={2}
            placeholder="Which campaign brought the most registrations this week?"
            className="w-full resize-none bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              Enter to ask · Shift+Enter for a new line
            </span>
            <button
              type="submit"
              disabled={run.isPending || !draft.trim()}
              className="bg-primary rounded px-3 py-1.5 text-[12px] font-medium text-primary-foreground disabled:opacity-40"
            >
              {run.isPending ? "Reading the database…" : "Ask"}
            </button>
          </div>
        </form>

        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTED_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => submit(q)}
              disabled={run.isPending}
              className="border-border rounded-full border px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40"
            >
              {q}
            </button>
          ))}
        </div>

        {run.isPending ? (
          <p className="mt-5 text-[12px] text-muted-foreground">
            Writing a query, running it read-only, then reading the rows back…
          </p>
        ) : null}

        <div className="mt-6 space-y-5">
          {turns.map((turn, i) => (
            <TurnCard key={`${turn.question}-${i}`} turn={turn} working={working} />
          ))}
        </div>

        {working && (log.data?.recent.length ?? 0) > 0 ? (
          <section className="mt-10">
            <h2 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Recently asked
            </h2>
            <ul className="mt-2 space-y-1">
              {log.data?.recent.map((row) => (
                <li key={row.id} className="text-[12px] text-muted-foreground">
                  <button
                    type="button"
                    className="text-left hover:text-foreground"
                    onClick={() => submit(row.question)}
                  >
                    {row.question}
                  </button>
                  {row.error ? <span className="ml-2 text-destructive">failed</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

function TurnCard({ turn }: { turn: Turn; working: boolean }) {
  const result = turn.result;
  const failed = turn.error ?? result?.error ?? null;

  return (
    <article className="border-border bg-card rounded-md border p-4">
      <p className="text-[12px] font-medium text-muted-foreground">{turn.question}</p>

      {failed ? (
        <p className="mt-2 text-[13px] text-destructive">{failed}</p>
      ) : (
        <p className="mt-2 text-[13.5px] leading-relaxed whitespace-pre-wrap">{result?.answer}</p>
      )}

      {result?.sql || (result?.steps?.length ?? 0) > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">
            How this was computed
          </summary>

          {result?.steps?.length ? (
            <ul className="mt-2 space-y-1">
              {result.steps.map((s, i) => (
                <li key={`${s.label}-${i}`} className="text-[11px] text-muted-foreground">
                  <span className="text-foreground">{s.label}:</span> {s.detail}
                </li>
              ))}
            </ul>
          ) : null}

          {result?.sql ? (
            <>
              <pre className="bg-muted/40 mt-2 overflow-x-auto rounded p-3 text-[11px] leading-relaxed">
                {result.sql}
              </pre>
              <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                {result.rows} row{result.rows === 1 ? "" : "s"} · {result.durationMs} ms ·
                read-only role, 500-row cap
              </p>
              {result.sample.length > 0 ? (
                <pre className="bg-muted/40 mt-2 max-h-64 overflow-auto rounded p-3 text-[11px]">
                  {JSON.stringify(result.sample.slice(0, 10), null, 1)}
                </pre>
              ) : null}
            </>
          ) : null}

          {result?.checkSql ? (
            <>
              <p className="mt-3 text-[11px] font-medium text-muted-foreground">
                Second source checked
              </p>
              <pre className="bg-muted/40 mt-1 overflow-x-auto rounded p-3 text-[11px] leading-relaxed">
                {result.checkSql}
              </pre>
              <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                {result.checkRows} row{result.checkRows === 1 ? "" : "s"}
              </p>
              {result.checkSample.length > 0 ? (
                <pre className="bg-muted/40 mt-2 max-h-64 overflow-auto rounded p-3 text-[11px]">
                  {JSON.stringify(result.checkSample.slice(0, 10), null, 1)}
                </pre>
              ) : null}
            </>
          ) : null}
        </details>
      ) : null}
    </article>
  );
}
