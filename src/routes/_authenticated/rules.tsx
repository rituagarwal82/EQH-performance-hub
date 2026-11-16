import { createFileRoute } from "@tanstack/react-router";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";

import { AppShell } from "@/components/AppShell";
import { formatINR, formatInt } from "@/lib/format";
import {
  deletePromotion,
  getPromotions,
  savePromotion,
  type Promotion,
} from "@/lib/promotions.functions";
import { RouteError } from "@/components/UiError";
import { Button } from "@/components/ui/button";
import {
  getRules,
  retireRuling,
  saveRuling,
  type Ruling,
  type RulesPayload,
} from "@/lib/rulings.functions";

const rulesQuery = () => queryOptions({ queryKey: ["owner-rules"], queryFn: () => getRules() });

export const Route = createFileRoute("/_authenticated/rules")({
  loader: ({ context }) => context.queryClient.ensureQueryData(rulesQuery()),
  head: () => ({
    meta: [
      { title: "Decisions & rules — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Every rule this engine obeys, in the owner's own words: how sales are counted, where a sale's source comes from, who the agencies are, and what we still cannot see.",
      },
      { property: "og:title", content: "Decisions & rules — EQH Performance Engine" },
      {
        property: "og:description",
        content: "The rulebook behind every figure, with who decided it and when.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: RulesPage,
  errorComponent: ({ error, reset }) => (
    <RouteError error={error} reset={reset} subject="the rulebook" where="src/routes/rules.tsx" />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

const SECTIONS: { key: string; title: string; blurb: string }[] = [
  { key: "A", title: "How we count", blurb: "What a sale is, and on what basis money is reported." },
  {
    key: "B",
    title: "Where a sale's source comes from",
    blurb: "The first-touch law and the order of evidence behind every credit.",
  },
  { key: "C", title: "Who the agencies are", blurb: "Teams, accounts and the history that never moves." },
  { key: "D", title: "Non-agency sources", blurb: "Podcasts, collaborations, talks and what is not a source." },
  { key: "E", title: "Tracking conventions every agency must follow", blurb: "What must be on every link and campaign." },
  { key: "F", title: "What we still cannot see", blurb: "Kept honest and current." },
];

const AGENCY_NAME: Record<string, string> = {
  SD: "Sabhi Digital",
  RJ: "Rajdeep (in-house)",
  SX: "ScaleX",
  PRM: "Parami (Parnami)",
  TS: "Tushar",
  VL: "Vlad",
};

function agencyName(code: string) {
  return AGENCY_NAME[code] ?? code;
}

function longDate(d: string | null) {
  if (!d) return null;
  const parsed = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return d;
  return parsed.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Auto({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

function RulingCard({
  r,
  onEdit,
  onRetire,
}: {
  r: Ruling;
  onEdit: () => void;
  onRetire: () => void;
}) {
  return (
    <article className="border-border rounded-md border bg-card p-4">
      <div className="flex items-start gap-3">
        <h3 className="flex-1 text-sm font-semibold">{r.title}</h3>
        <button onClick={onEdit} className="text-[11px] text-muted-foreground underline hover:text-foreground">
          Edit
        </button>
        <button onClick={onRetire} className="text-[11px] text-muted-foreground underline hover:text-foreground">
          Retire
        </button>
      </div>
      <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-foreground">{r.body}</p>
      {r.why ? <p className="mt-2 text-[12px] italic text-muted-foreground">Why: {r.why}</p> : null}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Decided by {r.decided_by}
        {r.decided_on ? ` · ${longDate(r.decided_on)}` : ""}
      </p>
    </article>
  );
}

function AutoBlock({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <article className="border-border rounded-md border border-dashed bg-muted/30 p-4">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold">{title}</h3>
        <Auto>kept automatically</Auto>
      </div>
      <p className="mt-1 text-[12px] text-muted-foreground">{note}</p>
      <div className="mt-3 text-[13px]">{children}</div>
    </article>
  );
}

function AutoSections({ section, data }: { section: string; data: RulesPayload }) {
  if (section === "C") {
    return (
      <>
        <AutoBlock
          title="Ad accounts and who owned them, period by period"
          note="Read from the ownership record itself, so it can never disagree with the figures."
        >
          {data.ownership.length === 0 ? (
            <p className="text-muted-foreground">no data</p>
          ) : (
            <ul className="space-y-1.5">
              {data.ownership.map((o) => (
                <li key={`${o.account_id}-${o.valid_from}`}>
                  <span className="font-medium">{o.account_name ?? o.account_id}</span> —{" "}
                  {agencyName(o.agency_code)}{" "}
                  {o.valid_to
                    ? `up to ${longDate(o.valid_to)}`
                    : `from ${longDate(o.valid_from)} onwards`}
                </li>
              ))}
            </ul>
          )}
        </AutoBlock>
        {data.holds.length > 0 ? (
          <AutoBlock
            title="Teams whose cost and return figures are held back"
            note="A team's ratios stay hidden until its own spend and lead tracking line up."
          >
            <ul className="space-y-1.5">
              {data.holds.map((h) => (
                <li key={h.agency_code}>
                  <span className="font-medium">{agencyName(h.agency_code)}</span> —{" "}
                  {h.ratios_hold_reason ?? "held"}
                </li>
              ))}
            </ul>
          </AutoBlock>
        ) : null}
      </>
    );
  }

  if (section === "D") {
    const groups = new Map<string, string[]>();
    for (const s of data.namedSources) {
      const list = groups.get(s.channel_group) ?? [];
      list.push(s.display_name);
      groups.set(s.channel_group, list);
    }
    return (
      <AutoBlock
        title="The named people and events the engine recognises"
        note="Read from the source list the engine actually uses when it labels a registration."
      >
        {groups.size === 0 ? (
          <p className="text-muted-foreground">no data</p>
        ) : (
          <div className="space-y-2">
            {[...groups.entries()].map(([group, names]) => (
              <div key={group}>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {group}
                </div>
                <div className="text-[13px]">{names.join(" · ")}</div>
              </div>
            ))}
          </div>
        )}
      </AutoBlock>
    );
  }

  if (section === "F") {
    return (
      <>
        <AutoBlock
          title="Ad accounts spending without working lead tracking"
          note="Live list — an account leaves it the moment its tracking is confirmed working."
        >
          {data.blindSpots.length === 0 ? (
            <p>Every spending account has working lead tracking.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.blindSpots.map((a) => {
                // The account's own label is its original owner; the ownership
                // record is what decides who holds it today.
                const current = data.ownership.find(
                  (o) => o.account_id === a.account_id && o.valid_to === null,
                );
                const code = current?.agency_code ?? a.agency_code;
                return (
                <li key={a.account_id}>
                  <span className="font-medium">{a.name ?? a.account_id}</span>
                  {code ? ` (${agencyName(code)})` : ""} — tracking{" "}
                  {a.lead_tracking_status === "broken" ? "not working" : "not confirmed"}
                </li>
                );
              })}
            </ul>
          )}
        </AutoBlock>
        <AutoBlock
          title="Connections and when they expire"
          note="Read from the connections register the safety net watches."
        >
          <ul className="space-y-1.5">
            {data.credentials.map((c) => (
              <li key={c.key}>
                <span className="font-medium">{c.label}</span> —{" "}
                {c.expires_at ? `expires ${longDate(c.expires_at)}` : "no expiry date recorded"}
                {c.what_breaks ? `. If it lapses: ${c.what_breaks}` : ""}
              </li>
            ))}
          </ul>
        </AutoBlock>
      </>
    );
  }

  return null;
}

type Draft = {
  id?: string;
  section: string;
  title: string;
  body: string;
  decided_by: string;
  decided_on: string;
  why: string;
  changed_by: string;
};

function emptyDraft(section: string): Draft {
  return {
    section,
    title: "",
    body: "",
    decided_by: "Owner",
    decided_on: new Date().toISOString().slice(0, 10),
    why: "",
    changed_by: "Ritu",
  };
}

function RulesPage() {
  const { data } = useSuspenseQuery(rulesQuery());
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (d: Draft) =>
      saveRuling({
        data: {
          id: d.id,
          section: d.section,
          title: d.title,
          body: d.body,
          decided_by: d.decided_by,
          decided_on: d.decided_on || null,
          why: d.why || null,
          changed_by: d.changed_by || null,
        },
      }),
    onSuccess: (res) => {
      setNote(res.ok ? "Saved, and the change is logged." : (res.error ?? "That did not save."));
      if (res.ok) setDraft(null);
      void qc.invalidateQueries({ queryKey: ["owner-rules"] });
    },
    onError: () => setNote("That did not save. Please try again."),
  });

  const retire = useMutation({
    mutationFn: (id: string) => retireRuling({ data: { id, changed_by: "Ritu" } }),
    onSuccess: () => {
      setNote("Rule retired. It stays in the change log.");
      void qc.invalidateQueries({ queryKey: ["owner-rules"] });
    },
  });

  return (
    <AppShell
      topBar={
        <div className="flex w-full items-baseline gap-3">
          <h1 className="text-sm font-semibold">Decisions &amp; rules</h1>
          <span className="truncate text-xs text-muted-foreground">
            Every rule this engine obeys, in your words.
          </span>
        </div>
      }
    >
      <div className="mx-auto max-w-4xl space-y-8 px-4 py-6 md:px-6">
        {data.error ? (
          <p className="border-border rounded border bg-card p-3 text-sm">
            The rulebook could not be read just now. Nothing has changed.
          </p>
        ) : null}
        {note ? (
          <p className="border-border rounded border bg-card p-3 text-[13px]">{note}</p>
        ) : null}

        {SECTIONS.map((s) => {
          const rows = data.rulings.filter((r) => r.section === s.key);
          return (
            <section key={s.key} className="space-y-3">
              <div>
                <h2 className="text-base font-semibold">{s.title}</h2>
                <p className="text-[12px] text-muted-foreground">{s.blurb}</p>
              </div>
              {rows.map((r) => (
                <RulingCard
                  key={r.id}
                  r={r}
                  onEdit={() =>
                    setDraft({
                      id: r.id,
                      section: r.section,
                      title: r.title,
                      body: r.body,
                      decided_by: r.decided_by,
                      decided_on: r.decided_on ?? "",
                      why: r.why ?? "",
                      changed_by: "Ritu",
                    })
                  }
                  onRetire={() => retire.mutate(r.id)}
                />
              ))}
              <AutoSections section={s.key} data={data} />
              <Button variant="outline" size="sm" onClick={() => setDraft(emptyDraft(s.key))}>
                Add a rule here
              </Button>
            </section>
          );
        })}

        <PromotionsSection />

        {data.changes.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-base font-semibold">Change log</h2>
            <ul className="border-border divide-border divide-y rounded-md border bg-card text-[12px]">
              {data.changes.map((c) => (
                <li key={c.id} className="px-3 py-2">
                  {c.action === "added" ? "Added" : c.action === "retired" ? "Retired" : "Edited"}
                  {c.after_value?.title ? ` “${c.after_value.title}”` : ""} by{" "}
                  {c.changed_by ?? "owner"} on{" "}
                  {new Date(c.changed_at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {draft ? (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="border-border mt-10 w-full max-w-xl space-y-3 rounded-md border bg-card p-4">
            <h3 className="text-sm font-semibold">{draft.id ? "Edit this rule" : "Add a rule"}</h3>
            <label className="block text-[12px]">
              Heading
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                className="border-border mt-1 w-full rounded border bg-background px-2 py-1 text-[13px]"
              />
            </label>
            <label className="block text-[12px]">
              The rule, in your words
              <textarea
                value={draft.body}
                rows={5}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                className="border-border mt-1 w-full rounded border bg-background px-2 py-1 text-[13px]"
              />
            </label>
            <label className="block text-[12px]">
              Why (one line)
              <input
                value={draft.why}
                onChange={(e) => setDraft({ ...draft, why: e.target.value })}
                className="border-border mt-1 w-full rounded border bg-background px-2 py-1 text-[13px]"
              />
            </label>
            <div className="flex gap-3">
              <label className="flex-1 text-[12px]">
                Decided by
                <input
                  value={draft.decided_by}
                  onChange={(e) => setDraft({ ...draft, decided_by: e.target.value })}
                  className="border-border mt-1 w-full rounded border bg-background px-2 py-1 text-[13px]"
                />
              </label>
              <label className="flex-1 text-[12px]">
                Date decided
                <input
                  type="date"
                  value={draft.decided_on}
                  onChange={(e) => setDraft({ ...draft, decided_on: e.target.value })}
                  className="border-border mt-1 w-full rounded border bg-background px-2 py-1 text-[13px]"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(draft)}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

/**
 * Promotions belong in the rulebook: they change the price, and without them
 * a discounted week reads as a fall in performance.
 */
/** A new offer starts from the standing list price already on record. */
function emptyPromotion(listPrice: number): Promotion {
  return {
    code: "",
    name: "",
    discounted_price: 0,
    list_price: listPrice,
    starts_on: null,
    ends_on: null,
    dates_confirmed: false,
    note: null,
    is_active: true,
  };
}

/**
 * Offers recur, so the register holds many — past, present and future — and the
 * owner adds them himself. Nothing here values a sale: the price is recorded so
 * a discounted week is not misread as a fall in performance.
 */
function PromotionsSection() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["promotions"],
    queryFn: () => getPromotions(),
    staleTime: 5 * 60_000,
  });
  const [draft, setDraft] = useState<Promotion | null>(null);
  const savePromo = useMutation({
    mutationFn: (p: Promotion) => savePromotion({ data: p }),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["promotions"] });
      await queryClient.invalidateQueries({ queryKey: ["price-mix"] });
    },
  });
  const removePromo = useMutation({
    mutationFn: (code: string) => deletePromotion({ data: { code } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["promotions"] });
      await queryClient.invalidateQueries({ queryKey: ["price-mix"] });
    },
  });
  const promos = data?.promotions ?? [];
  const totals = data?.totals ?? [];
  const day = (d: string | null) =>
    d
      ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null;

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    type: "text" | "number" | "date" = "text",
  ) => (
    <label className="block text-[12px]">
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-border mt-1 w-full rounded border bg-background px-2 py-1 text-[13px]"
      />
    </label>
  );

  return (
    <section className="space-y-3">
      <div className="flex items-start gap-3">
        <div>
          <h2 className="text-base font-semibold">Offers</h2>
          <p className="text-[12px] text-muted-foreground">
            Offers that change the price actually charged. Every cost per sale, return and cohort
            figure uses the cash received, never an assumed price. Add past, present and future
            offers here.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() => setDraft(emptyPromotion(Number(promos[0]?.list_price ?? 0)))}
        >
          Add an offer
        </Button>
      </div>
      {promos.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">No offers recorded yet.</p>
      ) : null}
      {promos.map((p) => {
        const t = totals.find((x) => x.code === p.code);
        return (
          <article key={p.code} className="border-border rounded-md border bg-card p-3 text-[13px]">
            <div className="flex items-start gap-2">
              <h3 className="font-semibold">{p.name}</h3>
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => setDraft({ ...p })}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={removePromo.isPending}
                  onClick={() => removePromo.mutate(p.code)}
                >
                  Remove
                </Button>
              </div>
            </div>
            <p className="text-muted-foreground">
              Code {p.code} — {formatINR(p.discounted_price)} instead of {formatINR(p.list_price)}.
            </p>
            <p className="text-muted-foreground">
              {p.starts_on ? `Starts ${day(p.starts_on)}` : "Start date not set"}
              {p.ends_on ? ` · ends ${day(p.ends_on)}` : " · no end date set"}
              {p.dates_confirmed ? " (confirmed)" : " — dates still to be confirmed with the owner"}
            </p>
            {t ? (
              <p className="mt-1">
                {formatInt(t.sales)} sale{Number(t.sales) === 1 ? "" : "s"} so far ·{" "}
                {formatINR(t.cash_received)} received · {formatINR(t.discount_given)} given away ·
                average sale {t.avg_sale_value === null ? "no data" : formatINR(t.avg_sale_value)}.
              </p>
            ) : null}
            {p.note ? <p className="mt-1 text-muted-foreground">{p.note}</p> : null}
          </article>
        );
      })}

      {draft ? (
        <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
          <div className="border-border mt-10 w-full max-w-xl space-y-3 rounded-md border bg-card p-4">
            <h3 className="text-sm font-semibold">An offer</h3>
            {field("Name of the offer", draft.name, (v) => setDraft({ ...draft, name: v }))}
            {field("Code buyers type", draft.code, (v) => setDraft({ ...draft, code: v }))}
            <div className="flex gap-3">
              <div className="flex-1">
                {field(
                  "Price charged (₹)",
                  String(draft.discounted_price),
                  (v) => setDraft({ ...draft, discounted_price: Number(v) }),
                  "number",
                )}
              </div>
              <div className="flex-1">
                {field(
                  "Usual price (₹)",
                  String(draft.list_price),
                  (v) => setDraft({ ...draft, list_price: Number(v) }),
                  "number",
                )}
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                {field(
                  "Starts on",
                  draft.starts_on ?? "",
                  (v) => setDraft({ ...draft, starts_on: v || null }),
                  "date",
                )}
              </div>
              <div className="flex-1">
                {field(
                  "Ends on",
                  draft.ends_on ?? "",
                  (v) => setDraft({ ...draft, ends_on: v || null }),
                  "date",
                )}
              </div>
            </div>
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={draft.dates_confirmed}
                onChange={(e) => setDraft({ ...draft, dates_confirmed: e.target.checked })}
              />
              These dates are confirmed
            </label>
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={draft.is_active}
                onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
              />
              This offer is live
            </label>
            {field("Note (optional)", draft.note ?? "", (v) =>
              setDraft({ ...draft, note: v || null }),
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={savePromo.isPending || draft.code.length < 2 || draft.name.length < 2}
                onClick={() => savePromo.mutate(draft)}
              >
                {savePromo.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
