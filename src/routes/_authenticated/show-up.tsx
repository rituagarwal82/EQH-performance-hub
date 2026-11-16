import { DENSITIES, GRAINS, type Density, type Grain } from "@/lib/view-prefs";
import { useDensityMode } from "@/components/DensityProvider";
import { uiMessage } from "@/lib/error-copy";
import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { UiError, RouteError } from "@/components/UiError";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LabelList,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { DataMenu } from "@/components/DataMenu";
import { Disclosure } from "@/components/Disclosure";
import { Kpi } from "@/components/Kpi";
import { RangeBar, type RangeSearch } from "@/components/RangeBar";
import { MetricValue, renderMetric } from "@/components/MetricValue";
import { fromNullable, rate, sumMetrics, suspect, toNum, unmeasured } from "@/lib/metric";
import { count } from "@/lib/counts";
import { resolveRange, type RangePreset } from "@/lib/date-range";
import { NO_DATA } from "@/lib/format";
import {
  getRetentionCurve,
  getWebinars,
  triggerZoomSync,
  type SourceStatus,
  type WebinarsData,
  type ZoomSessionRow,
} from "@/lib/zoom.functions";

const BACKFILL_START = "2025-09-01";

/** Show-up is read over weeks, not days — a single session is not a trend. */
const SHOW_UP_DEFAULT_PRESET: RangePreset = "last30";

const webinarsQuery = (since: string, until: string) =>
  queryOptions({
    queryKey: ["webinars", since, until],
    queryFn: () => getWebinars({ data: { since, until } }),
  });

export const Route = createFileRoute("/_authenticated/show-up")({
  validateSearch: (search: Record<string, unknown>): RangeSearch => ({
    range: (search["range"] as RangePreset) ?? SHOW_UP_DEFAULT_PRESET,
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
    const r = resolveRange(deps.range ?? SHOW_UP_DEFAULT_PRESET, {
      since: deps.since,
      until: deps.until,
    });
    return context.queryClient.ensureQueryData(webinarsQuery(r.since, r.until));
  },
  head: () => ({
    meta: [
      { title: "Show-up — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Zoom L1 webinar sessions for Energy Queens Hub: registrants, attendees, show-up rate and 30/60/90-minute retention per session.",
      },
      { property: "og:title", content: "Show-up — EQH Performance Engine" },
      {
        property: "og:description",
        content:
          "Registrants, attendees, show-up rate and retention for every L1 webinar session, deduplicated across rejoins.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Webinars,
  errorComponent: ({ error, reset }) => (
    <RouteError
      error={error}
      reset={reset}
      subject="the show-up view"
      where="src/routes/show-up.tsx"
    />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

const IST = "Asia/Kolkata";

/**
 * Slot is derived from START TIME IST, which is deterministic. Topic text is
 * not: afternoon replays are often titled with just a date, and some evening
 * sessions are titled "Replay Session". Every split, label and comparison on
 * this screen is driven by the slot; the topic-derived role stays visible as a
 * secondary column, and disagreements are shown rather than silently resolved.
 */
function slotOf(iso: string | null): "Afternoon" | "Evening" | "Other" {
  if (!iso) return "Other";
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(iso)),
  );
  if (hour >= 11 && hour < 17) return "Afternoon";
  if (hour >= 17 && hour <= 22) return "Evening";
  return "Other";
}

/** The role the slot implies: afternoon is the replay slot, evening the live one. */
function slotRole(slot: "Afternoon" | "Evening" | "Other"): "live" | "replay" | null {
  if (slot === "Afternoon") return "replay";
  if (slot === "Evening") return "live";
  return null;
}

/** True when the hand-typed topic label contradicts the deterministic slot. */
function roleDisagrees(role: string | null, slot: "Afternoon" | "Evening" | "Other") {
  const implied = slotRole(slot);
  if (!implied || !role) return false;
  if (role !== "live" && role !== "replay") return false;
  return role !== implied;
}

function istTime(iso: string | null) {
  if (!iso) return NO_DATA;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return NO_DATA;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(t);
}

/**
 * Every rate on this screen goes through `rate()`: under 30 registrants it is
 * unmeasured (a show-up rate off a denominator of 1 is noise), and above 100%
 * it is suspect (the source disagrees with itself). Neither can enter a total,
 * a ranking, or a verdict.
 */
function showUpRate(part: number | null | undefined, whole: number | null | undefined) {
  const m = rate(fromNullable(part), fromNullable(whole));
  // More attendees than registrants is real on a replay: Zoom counts anyone who
  // opens the link, while the registrant list only holds people who signed up
  // for that session. Say that, rather than blaming the source.
  if (m.state === "suspect" && typeof part === "number" && typeof whole === "number") {
    return suspect(
      m.value ?? (part / whole) * 100,
      `${part} people attended against ${whole} registered — someone joined without registering for this session, so this is not a share of registrations`,
    );
  }
  return m;
}

/** Retention curves are read off attendees, so a smaller floor applies. */
function retentionRate(part: number | null | undefined, whole: number | null | undefined) {
  return rate(fromNullable(part), fromNullable(whole), { min: 10 });
}

function legibleZoomError(error: string) {
  const scopes = Array.from(
    new Set(
      [...error.matchAll(/scopes?:\[([^\]]+)\]/gi)]
        .flatMap((match) => (match[1] ?? "").split(","))
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  );
  if (scopes.length > 0) {
    return `Zoom rejected the request: your app is missing ${scopes.length === 1 ? "the scope" : "one of the scopes"} ${scopes.join(", ")}. Ask whoever set up the Zoom app to add it.`;
  }
  if (/Zoom (400|401|403)|OAuth/i.test(error)) {
    return `Zoom rejected the request. The Zoom connection details need checking.`;
  }
  return error;
}

function SourcePanel({
  sources,
  checkedAt,
}: {
  sources: SourceStatus[];
  checkedAt: string | null;
}) {
  if (sources.length === 0) {
    return (
      <section className="border-border bg-card mb-5 rounded-md border px-4 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Zoom data sources
        </h2>
        <p className="mt-1.5 text-xs italic text-muted-foreground">
          {NO_DATA} — no sync has reported source availability yet.
        </p>
      </section>
    );
  }
  return (
    <section className="border-border bg-card mb-5 rounded-md border">
      <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Zoom data sources
        </h2>
        <span className="text-[11px] text-muted-foreground">
          {checkedAt ? `checked ${checkedAt.slice(0, 16).replace("T", " ")} UTC` : NO_DATA}
        </span>
      </div>
      <ul className="divide-border divide-y">
        {sources.map((s) => (
          <li key={s.source} className="flex gap-3 px-4 py-2.5 text-xs">
            <span
              className={`mt-0.5 inline-flex h-4 shrink-0 items-center rounded px-1.5 text-[10px] font-semibold uppercase tracking-wide ${
                s.available ? "bg-positive/15 text-positive" : "bg-warning/15 text-warning"
              }`}
            >
              {s.available ? "live" : "unavailable"}
            </span>
            <div className="min-w-0">
              <div className="font-medium text-foreground">
                {s.label}:{" "}
                {s.available && s.source !== "users" ? (
                  <span className="nums font-normal">
                    {count(s.sessionsReturned)} session{s.sessionsReturned === 1 ? "" : "s"}{" "}
                    returned · {count(s.matched)} matched the topic filter · {count(s.ignored)}{" "}
                    ignored
                  </span>
                ) : (
                  <span className="font-normal">
                    {s.available
                      ? (s.note ?? "available")
                      : s.source === "webinars"
                        ? "unavailable — no session read from this source"
                        : s.source === "meetings"
                          ? "unavailable — no session read from this source"
                          : "limited"}
                  </span>
                )}
              </div>
              {s.note && !(s.available && s.source === "users") ? (
                <p className="mt-0.5 text-muted-foreground">{s.note}</p>
              ) : null}
              {s.hosts.length > 0 ? (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  hosts: {s.hosts.join(", ")}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Webinars() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const range = resolveRange(search.range ?? SHOW_UP_DEFAULT_PRESET, {
    since: search.since,
    until: search.until,
  });
  const { data } = useSuspenseQuery(webinarsQuery(range.since, range.until));
  const view = data as WebinarsData;
  const runSync = useServerFn(triggerZoomSync);
  const { density } = useDensityMode();
  const working = density === "working";

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const [includeTest, setIncludeTest] = useState(false);
  const allSessions = view.sessions;
  const sessions = includeTest ? allSessions : allSessions.filter((r) => r.session_role !== "test");
  const events = view.events;
  const measured = sessions.filter(
    (r) => r.participants_status === "fetched" || r.participants_status === "empty",
  );
  // Totals are built only from sessions whose attendance we actually have.
  const totalAttendees = sumMetrics(measured.map((r) => fromNullable(r.attendees)));
  // 138 of 331 sessions carry no registrant count. Coercing those to zero put a
  // floor on screen captioned as fact; a null now makes the whole total partial.
  const totalRegistrants = sumMetrics(
    measured.map((r) => fromNullable(r.total_registrants)),
    "some sessions in this window never reported a registrant count",
  );
  const totalInvalid = sumMetrics(sessions.map((r) => fromNullable(r.invalid_rows)));
  const missingAttendance = sessions.length - measured.length;
  const testCount = allSessions.filter((r) => r.session_role === "test").length;
  const hasData = sessions.length > 0;

  const liveSessionSources = view.sources.filter((s) => s.source !== "users" && s.available);
  const deadSessionSources = view.sources.filter((s) => s.source !== "users" && !s.available);
  const emptyTableReason =
    view.sources.length === 0
      ? `${NO_DATA} — the Zoom sync has not run yet.`
      : liveSessionSources.length === 0
        ? `no sessions can be read: ${deadSessionSources.map((s) => `${s.label} — ${s.note ?? "unavailable"}`).join(" · ")}`
        : `${NO_DATA} — ${liveSessionSources.map((s) => s.label).join(" and ")} returned no session matching the topic filter in this range.`;

  const lastRun = view.lastRun;
  const persistedSyncError =
    lastRun?.status === "error" && lastRun.error ? legibleZoomError(lastRun.error) : null;
  const visibleSyncError = syncError ? legibleZoomError(syncError) : persistedSyncError;
  const lastOk = lastRun && lastRun.status === "success" ? lastRun.finished_at : null;
  const ageH = lastOk ? (Date.now() - Date.parse(lastOk)) / 36e5 : null;
  const stale = ageH === null || ageH > 36;

  const selectedRow = sessions.find((r) => r.session_uuid === selected) ?? null;
  const curve = useQuery({
    queryKey: ["zoom-retention", selected],
    queryFn: () => getRetentionCurve({ data: { sessionUuid: selected as string } }),
    enabled: Boolean(selected),
  });

  const selectedSlot = selectedRow ? slotOf(selectedRow.start_time) : null;
  const bandRows = selectedRow
    ? measured.filter((r) => {
        if (r.session_uuid === selectedRow.session_uuid) return false;
        if (slotOf(r.start_time) !== selectedSlot) return false;
        if (!r.business_date || !selectedRow.business_date) return false;
        const lag =
          (Date.parse(`${selectedRow.business_date}T00:00:00Z`) -
            Date.parse(`${r.business_date}T00:00:00Z`)) /
          86400000;
        const att = toNum(r.attendees);
        return lag > 0 && lag <= 28 && att !== null && att > 0;
      })
    : [];
  const bandSessions = bandRows.length;
  function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    const hi = s[mid] ?? null;
    const lo = s[mid - 1] ?? null;
    if (hi === null) return null;
    return s.length % 2 === 0 && lo !== null ? (lo + hi) / 2 : hi;
  }
  const bandPoints: Record<number, number | null> = {
    30: median(
      bandRows
        .map((r) => {
          const a = toNum(r.attendees);
          const v = toNum(r.at_30);
          return a !== null && a > 0 && v !== null ? (v / a) * 100 : null;
        })
        .filter((v): v is number => v !== null),
    ),
    60: median(
      bandRows
        .map((r) => {
          const a = toNum(r.attendees);
          const v = toNum(r.at_60);
          return a !== null && a > 0 && v !== null ? (v / a) * 100 : null;
        })
        .filter((v): v is number => v !== null),
    ),
    90: median(
      bandRows
        .map((r) => {
          const a = toNum(r.attendees);
          const v = toNum(r.at_90);
          return a !== null && a > 0 && v !== null ? (v / a) * 100 : null;
        })
        .filter((v): v is number => v !== null),
    ),
  };
  const bandAt = (minute: number): number | null =>
    minute === 0 ? (bandRows.length > 0 ? 100 : null) : (bandPoints[minute] ?? null);

  /**
   * Both curves are shares of attendees. The comparison band is the median of
   * the trailing four weeks of sessions in the SAME slot — an afternoon replay
   * is never averaged against an evening live session.
   */
  const attendeesOfSelected = selectedRow ? toNum(selectedRow.attendees) : null;
  const normalisedCurve =
    !selectedRow || !attendeesOfSelected || attendeesOfSelected <= 0
      ? []
      : (curve.data ?? []).map((p, i, arr) => {
          const present = toNum(p.present);
          const minute = toNum(p.minute);
          const pct = present === null ? 0 : (present / attendeesOfSelected) * 100;
          const band = bandAt(minute === null ? 0 : minute);
          return {
            minute: minute === null ? 0 : minute,
            pct,
            band,
            endLabel: i === arr.length - 1 ? `${Math.round(pct)}%` : "",
            bandLabel: i === arr.length - 1 && band !== null ? `${Math.round(band)}% median` : "",
          };
        });

  async function onSync(range?: { since: string; until: string }) {
    setSyncing(true);
    setSyncError(null);
    const id = toast.loading(range ? "Backfilling Zoom sessions…" : "Syncing Zoom…");
    try {
      const result = await runSync({ data: range ?? {} });
      if (result.status === "error") {
        const message = result.error ?? "Zoom sync failed without an error message.";
        setSyncError(message);
        toast.error(message, { id });
      } else {
        toast.success(
          `${result.status === "partial" ? "Partial sync" : "Sync complete"} · ${count(result.sessionsMatched)} matched · ${count(result.sessionsIgnored)} ignored · ${count(result.participantRowsWritten)} participant rows · ${count(result.invalidRows)} invalid`,
          { id, description: result.error ?? undefined },
        );
        if (result.error) setSyncError(result.error);
      }
    } catch (e) {
      const message = uiMessage(e, "the Zoom sync");
      setSyncError(message);
      toast.error(message, { id });
    } finally {
      setSyncing(false);
    }
  }

  // Show-up compares like with like: only attendees from sessions that also
  // reported a registrant count enter the numerator.
  const withRegistrants = measured.filter((r) => toNum(r.total_registrants) !== null);
  const matchedAttendees = sumMetrics(withRegistrants.map((r) => fromNullable(r.attendees)));
  const matchedRegistrants = sumMetrics(
    withRegistrants.map((r) => fromNullable(r.total_registrants)),
  );
  const showUpHeadline = rate(matchedAttendees, matchedRegistrants);
  const at60Total = sumMetrics(measured.map((r) => fromNullable(r.at_60)));
  const retention60 = rate(at60Total, totalAttendees, { min: 10 });
  const sessionsWithoutRegistrants = measured.length - withRegistrants.length;

  return (
    <AppShell
      topBar={
        <RangeBar
          title="Show-up"
          search={search}
          range={range}
          onChange={(next) => void navigate({ search: (prev) => ({ ...prev, ...next }) })}
          right={
            <>
              <div
                className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium ${
                  stale ? "bg-warning/15 text-warning" : "bg-positive/15 text-positive"
                }`}
                title={
                  lastRun?.started_at ? `Last Zoom run started ${lastRun.started_at}` : undefined
                }
              >
                {stale ? (
                  <AlertTriangle className="size-3.5" />
                ) : (
                  <CheckCircle2 className="size-3.5" />
                )}
                {ageH === null
                  ? lastRun?.status
                    ? `Zoom last run ${lastRun.status}`
                    : "Zoom never synced"
                  : `Zoom synced ${ageH < 1 ? "<1" : Math.round(ageH)}h ago`}
              </div>
              <DataMenu
                actions={[
                  {
                    key: "zoom-sync",
                    label: "Sync Zoom",
                    description: "Re-read recent Zoom sessions and their attendance.",
                    run: async () => {
                      await onSync();
                      return "Zoom sync finished.";
                    },
                  },
                  {
                    key: "zoom-backfill",
                    label: "Backfill Zoom",
                    description: `Re-read every session since ${BACKFILL_START}.`,
                    confirm: `Backfill Zoom sessions from ${BACKFILL_START} to today? Zoom's reports API retains roughly a year, so anything older will simply be absent.`,
                    run: async () => {
                      await onSync({
                        since: BACKFILL_START,
                        until: new Date().toISOString().slice(0, 10),
                      });
                      return "Zoom backfill finished.";
                    },
                  },
                ]}
              />
            </>
          }
        />
      }
    >
      <div className="px-6 py-5">
        {view.error ? (
          <UiError
            detail={view.error}
            subject="the webinar figures"
            where="src/routes/show-up.tsx"
            className="border-destructive/40 bg-destructive/10 mb-5 rounded-md border px-4 py-3"
          />
        ) : null}

        {visibleSyncError ? (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/10 mb-5 rounded-md border px-4 py-3 text-xs text-destructive"
          >
            <div className="font-semibold">Zoom sync reported problems</div>
            <pre className="mt-1 whitespace-pre-wrap break-words font-mono">{visibleSyncError}</pre>
          </div>
        ) : null}

        {/* Layer 1: did they turn up, and did they stay? */}
        <section className="border-border bg-card grid grid-cols-2 rounded-md border md:grid-cols-4">
          <Kpi
            label="Show-up rate"
            metric={showUpHeadline}
            format="percent"
            provenance="show_up_rate"
            hint="attendees ÷ registrants"
            {...(sessionsWithoutRegistrants > 0
              ? {
                  note: `${count(sessionsWithoutRegistrants)} session${sessionsWithoutRegistrants === 1 ? "" : "s"} reported attendance but no registrant count — excluded from this ratio`,
                }
              : {})}
          />
          <Kpi
            label="Still there at 60 min"
            metric={retention60}
            format="percent"
            contract="retention_60"
            hint="share of attendees"
          />
          <Kpi
            label="Attendees"
            metric={totalAttendees}
            hint="rejoins collapsed"
            provenance="show_up_rate"
          />
          <Kpi
            label="Registrants"
            metric={totalRegistrants}
            provenance="registrations"
            footer={
              <span>
                {hasData ? count(sessions.length) : NO_DATA} session
                {sessions.length === 1 ? "" : "s"} in this range
              </span>
            }
          />
        </section>

        {working ? (
          <div className="mt-5">
            <SourcePanel sources={view.sources} checkedAt={view.sourcesCheckedAt} />
          </div>
        ) : null}

        {working ? (
          <section className="border-border bg-card mt-5 grid grid-cols-2 rounded-md border md:grid-cols-3">
            <Kpi
              label="Sessions matched"
              value={hasData ? count(sessions.length) : NO_DATA}
              hint="topic filter, this range"
            />
            <Kpi
              label="Sessions ignored"
              value={view.ignoredCount > 0 ? count(view.ignoredCount) : hasData ? "0" : NO_DATA}
              hint="topic did not match"
            />
            <Kpi
              label="Invalid rows rejected"
              metric={hasData ? totalInvalid : unmeasured("no sessions in this window")}
              hint="excluded from every figure"
            />
          </section>
        ) : null}

        {!hasData && !visibleSyncError ? (
          <div className="border-border bg-card mt-5 rounded-md border px-6 py-10 text-center">
            <p className="text-sm font-medium">{emptyTableReason}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Every figure on this screen comes from synced Zoom rows. Nothing is estimated.
            </p>
          </div>
        ) : null}

        <SlotSplit rows={measured} />

        <DailySlots rows={sessions} offDays={view.offDays ?? []} />

        {/* Ignored sessions */}
        <section className={working ? "mt-5" : "hidden"}>
          <button
            onClick={() => setShowIgnored((v) => !v)}
            className="text-[11px] uppercase tracking-wider text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {count(view.ignoredCount)} sessions ignored by the topic filter — click to review
          </button>
          {showIgnored ? (
            <div className="border-border bg-card mt-2 max-h-80 overflow-auto rounded-md border">
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead className="bg-muted/60 sticky top-0">
                    <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                      <th className="text-left">Start (IST)</th>
                      <th className="text-left">Type</th>
                      <th className="text-left">Topic</th>
                      <th className="text-left">Host</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.ignored.length === 0 ? (
                      <tr>
                        <td
                          colSpan={4}
                          className="px-4 py-6 text-center text-xs text-muted-foreground"
                        >
                          {NO_DATA}
                        </td>
                      </tr>
                    ) : (
                      view.ignored.map((s) => (
                        <tr
                          key={s.session_uuid}
                          className="border-border border-t text-muted-foreground [&>td]:px-3 [&>td]:py-1.5"
                        >
                          <td className="nums whitespace-nowrap">
                            {s.start_time
                              ? `${s.start_time.slice(0, 10)} ${istTime(s.start_time)}`
                              : NO_DATA}
                          </td>
                          <td className="text-[11px] uppercase">{s.session_type ?? NO_DATA}</td>
                          <td className="text-foreground">{s.topic ?? NO_DATA}</td>
                          <td className="text-[11px]">{s.host_email ?? NO_DATA}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </section>

        {/* Logical events: live + replay collapsed into one webinar event */}
        <section
          className={`border-border bg-card mt-5 rounded-md border ${working ? "" : "hidden"}`}
        >
          <div className="border-border flex items-center justify-between border-b px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Webinar events (live + replay collapsed)
            </h2>
            <span className="text-[11px] text-muted-foreground">
              one row per logical webinar · registrants deduplicated across its sessions
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                  <th className="text-left">Event date</th>
                  <th className="text-left">Event</th>
                  <th className="text-right">Sessions</th>
                  <th className="text-right">Live</th>
                  <th className="text-right">Replay</th>
                  <th className="text-right">Registrants</th>
                  <th className="text-right">Attendees</th>
                  <th className="text-right">Show-up</th>
                  <th className="text-right">@60m</th>
                  <th className="text-right">Missing attendance</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 ? (
                  <tr>
                    <td
                      colSpan={10}
                      className="px-4 py-6 text-center text-xs text-muted-foreground"
                    >
                      {emptyTableReason}
                    </td>
                  </tr>
                ) : (
                  events.map((e) => {
                    const att = e.attendees;
                    const unknown = (
                      <span className="text-xs italic text-muted-foreground">{NO_DATA}</span>
                    );
                    return (
                      <tr
                        key={e.event_key}
                        className="border-border border-b last:border-b-0 [&>td]:px-3 [&>td]:py-1.5"
                      >
                        <td className="nums whitespace-nowrap font-medium">
                          {e.event_date ?? NO_DATA}
                        </td>
                        <td className="max-w-[22rem] truncate" title={e.event_key}>
                          {e.event_key}
                        </td>
                        <td className="nums text-right">{count(e.sessions)}</td>
                        <td className="nums text-right text-muted-foreground">
                          {count(e.live_sessions)}
                        </td>
                        <td className="nums text-right text-muted-foreground">
                          {count(e.replay_sessions)}
                        </td>
                        <td className="nums text-right">
                          {e.registrants === null ? unknown : count(e.registrants)}
                        </td>
                        <td className="nums text-right font-semibold">
                          {att === null ? unknown : count(att)}
                        </td>
                        <td className="nums text-right">
                          {/* Show-up compares like with like: only attendees from
                              sessions that also reported registrants. A replay
                              session with attendees but no registrant list would
                              otherwise push the ratio above what happened. */}
                          <MetricValue
                            metric={showUpRate(e.attendees_matched, e.registrants)}
                            format="percent"
                          />
                          {e.sessions_without_registrants ? (
                            <span
                              className="ml-1 text-[10px] text-muted-foreground"
                              title={`${e.sessions_without_registrants} session(s) reported attendance but no registrant count — excluded from this ratio`}
                            >
                              ◆
                            </span>
                          ) : null}
                        </td>
                        <td className="nums text-right text-muted-foreground">
                          <MetricValue metric={retentionRate(e.at_60, att)} format="percent" />
                        </td>
                        <td className="nums text-right">
                          {e.sessions_missing_attendance ? (
                            <span className="text-warning font-medium">
                              {count(e.sessions_missing_attendance)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Sessions table */}
        <Disclosure
          className="mt-5"
          title="Session by session"
          teaser={`${count(sessions.length)} session${sessions.length === 1 ? "" : "s"} · pick one to draw its retention curve`}
        >
          <div className="border-border flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5">
            <span className="text-[11px] text-muted-foreground">
              business day 06:00–05:59 IST · minutes measured from the promised slot time
            </span>
            <div className="flex items-center gap-3">
              {missingAttendance > 0 ? (
                <span className="text-warning text-[11px] font-medium">
                  {count(missingAttendance)} of {count(sessions.length)} sessions have no attendance
                  data — totals exclude them
                </span>
              ) : null}
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  className="accent-primary h-3 w-3"
                  checked={includeTest}
                  onChange={(e) => setIncludeTest(e.target.checked)}
                />
                show test sessions ({count(testCount)})
              </label>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                  <th className="text-left">Business date</th>
                  <th className="text-left">Start IST</th>
                  <th className="text-left">Slot</th>
                  <th className="text-left">Topic label</th>

                  <th className="text-left">Topic</th>
                  <th className="text-right">Registrants</th>
                  <th className="text-right">Attendees</th>
                  <th className="text-right">Show-up</th>
                  <th className="text-right">@30m</th>
                  <th className="text-right">@60m</th>
                  <th className="text-right">@90m</th>
                  <th className="text-right">Attendance</th>
                  <th className="text-right">Invalid</th>
                </tr>
              </thead>
              <tbody>
                {!hasData ? (
                  <tr>
                    <td
                      colSpan={13}
                      className="px-4 py-6 text-center text-xs text-muted-foreground"
                    >
                      {emptyTableReason}
                    </td>
                  </tr>
                ) : (
                  sessions.map((r) => (
                    <SessionRow
                      key={r.session_uuid}
                      row={r}
                      selected={r.session_uuid === selected}
                      onSelect={() => setSelected(r.session_uuid)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Disclosure>

        {/* Retention curve — always a share of attendees, never a raw headcount,
            so a 40-person session and a 400-person one can be read together. */}
        {selectedRow ? (
          <div className="fixed inset-0 z-30 flex justify-end">
            <button
              aria-label="Close retention curve"
              onClick={() => setSelected(null)}
              className="bg-background/60 flex-1 backdrop-blur-[1px]"
            />
            <aside className="border-border bg-card flex h-full w-full max-w-[560px] flex-col overflow-y-auto border-l shadow-xl">
              <div className="border-border sticky top-0 flex items-start gap-3 border-b bg-card px-4 py-3">
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Retention curve
                  </div>
                  <div className="truncate text-sm font-semibold">
                    {selectedRow.business_date ?? NO_DATA} · {slotOf(selectedRow.start_time)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    minute-by-minute share of attendees
                  </div>
                </div>
                <button
                  onClick={() => setSelected(null)}
                  className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label="Close"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="p-4">
                {!selectedRow ? (
                  <p className="py-8 text-center text-xs italic text-muted-foreground">{NO_DATA}</p>
                ) : curve.isPending ? (
                  <p className="py-8 text-center text-xs text-muted-foreground">loading…</p>
                ) : (curve.data ?? []).length === 0 ? (
                  <p className="py-8 text-center text-xs italic text-muted-foreground">{NO_DATA}</p>
                ) : normalisedCurve.length === 0 ? (
                  <p className="py-8 text-center text-xs italic text-muted-foreground">
                    this session has no attendee count, so its curve cannot be expressed as a share
                  </p>
                ) : (
                  <>
                    <div className="mt-1 h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={normalisedCurve}
                          margin={{ top: 5, right: 42, bottom: 5, left: 0 }}
                        >
                          <CartesianGrid
                            stroke="var(--border)"
                            strokeDasharray="3 3"
                            vertical={false}
                          />
                          <XAxis
                            dataKey="minute"
                            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                            tickLine={false}
                            unit="m"
                          />
                          <YAxis
                            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                            tickLine={false}
                            domain={[0, 100]}
                            tickFormatter={(v: number) => `${v}%`}
                          />
                          <Tooltip
                            contentStyle={{
                              background: "var(--card)",
                              border: "1px solid var(--border)",
                              borderRadius: 6,
                              fontSize: 12,
                            }}
                            formatter={(v: number, k: string) => [
                              `${Math.round(v)}%`,
                              k === "band" ? "trailing 4-week median" : "this session",
                            ]}
                            labelFormatter={(m: number) => `${m} min in`}
                          />
                          <Line
                            type="monotone"
                            dataKey="band"
                            stroke="var(--muted-foreground)"
                            strokeWidth={1.5}
                            strokeDasharray="4 3"
                            dot={false}
                          >
                            <LabelList
                              dataKey="bandLabel"
                              position="right"
                              fontSize={10}
                              fill="var(--muted-foreground)"
                            />
                          </Line>
                          <Line
                            type="monotone"
                            dataKey="pct"
                            stroke="var(--primary)"
                            strokeWidth={2}
                            dot={false}
                          >
                            <LabelList
                              dataKey="endLabel"
                              position="right"
                              fontSize={10}
                              fill="var(--primary)"
                            />
                          </Line>
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Solid line: this session, as a share of its own attendees. Dashed line: the
                      median curve of the trailing four weeks of sessions in the same slot
                      {bandSessions === 0
                        ? " — no comparable sessions with attendance data exist yet, so no band is drawn"
                        : `, built from ${count(bandSessions)} session${bandSessions === 1 ? "" : "s"}`}
                      .
                    </p>
                  </>
                )}
              </div>
            </aside>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}

const ROLE_LABEL: Record<string, string> = {
  live: "Live",
  replay: "Replay",
  test: "Test",
  unknown: "Unclassified",
};

function RoleBadge({ role }: { role: string | null }) {
  const key = role ?? "unknown";
  const tone =
    key === "live"
      ? "bg-primary/10 text-primary"
      : key === "replay"
        ? "bg-muted text-muted-foreground"
        : key === "test"
          ? "bg-warning/15 text-warning"
          : "bg-muted text-muted-foreground italic";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
    >
      {ROLE_LABEL[key] ?? key}
    </span>
  );
}

/** Slot is read off the clock, so it is always known when a start time is. */
function SlotBadge({ slot }: { slot: "Afternoon" | "Evening" | "Other" }) {
  const tone =
    slot === "Afternoon"
      ? "bg-muted text-foreground"
      : slot === "Evening"
        ? "bg-primary/10 text-primary"
        : "bg-muted text-muted-foreground italic";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
      title={
        slot === "Other" ? "started outside both session windows" : "derived from start time (IST)"
      }
    >
      {slot}
    </span>
  );
}

/**
 * One row per business day showing BOTH slots, so a day where the afternoon
 * session is missing reads as missing rather than as nothing at all.
 *
 * A day on the owner-maintained off-day list is a FACT, not a gap: it renders
 * neutral grey as "no webinar scheduled". Amber is reserved for days where a
 * webinar ran and we failed to capture it.
 */
function DailySlots({ rows, offDays }: { rows: ZoomSessionRow[]; offDays: string[] }) {
  const withRows = Array.from(
    new Set(rows.map((r) => r.business_date).filter(Boolean) as string[]),
  );
  const first = withRows.length ? withRows.slice().sort()[0]! : null;
  const last = withRows.length ? withRows.slice().sort().reverse()[0]! : null;
  const offInRange = offDays.filter(
    (d) => first !== null && last !== null && d >= first && d <= last,
  );
  const days = Array.from(new Set([...withRows, ...offInRange]))
    .sort()
    .reverse();
  const isOff = (day: string) => offDays.includes(day);

  return (
    <section className="border-border bg-card mt-5 rounded-md border">
      <div className="border-border border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Day by day · afternoon and evening slot, both always shown
        </h2>
      </div>
      {days.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">{NO_DATA}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                <th className="text-left">Business date</th>
                <th className="text-left">Afternoon (11:00–16:59 IST)</th>
                <th className="text-left">Evening (17:00–22:00 IST)</th>
              </tr>
            </thead>
            <tbody>
              {days.map((day) => {
                const off = isOff(day);
                const cell = (slot: "Afternoon" | "Evening") => {
                  const list = rows.filter(
                    (r) => r.business_date === day && slotOf(r.start_time) === slot,
                  );
                  if (list.length === 0)
                    return off ? (
                      <span
                        className="text-[11px] italic text-muted-foreground"
                        title="Marked as an off day in Settings — no webinar was scheduled, so nothing is missing."
                      >
                        no webinar scheduled
                      </span>
                    ) : (
                      <span className="text-warning text-[11px] italic">
                        no session recorded in this slot
                      </span>
                    );
                  return (
                    <span className="flex flex-wrap items-center gap-1.5">
                      {list.map((r) => (
                        <span key={r.session_uuid} className="nums">
                          {istTime(r.start_time)} ·{" "}
                          {r.attendees === null ? NO_DATA : `${count(r.attendees)} attended`}
                          {roleDisagrees(r.session_role, slot) ? (
                            <span className="text-warning ml-1 text-[10px]">
                              (topic label disagrees with time slot)
                            </span>
                          ) : null}
                        </span>
                      ))}
                    </span>
                  );
                };
                return (
                  <tr
                    key={day}
                    className="border-border border-b last:border-b-0 [&>td]:px-3 [&>td]:py-1.5"
                  >
                    <td className="nums font-medium">
                      {day}
                      {off ? (
                        <span className="ml-1.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          off day
                        </span>
                      ) : null}
                    </td>
                    <td>{cell("Afternoon")}</td>
                    <td>{cell("Evening")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * A session with nobody in it and a session whose attendance we could not
 * retrieve must never render the same way. 'fetched' shows the numbers,
 * everything else replaces them with the reason.
 */
export function AttendanceStatus({ status, note }: { status: string | null; note: string | null }) {
  const map: Record<string, { label: string; tone: string }> = {
    fetched: { label: "fetched", tone: "text-muted-foreground" },
    empty: { label: "nobody attended", tone: "text-muted-foreground" },
    failed: { label: "fetch failed", tone: "text-destructive font-medium" },
    unavailable: { label: "unavailable from Zoom", tone: "text-warning font-medium" },
  };
  const hit = status ? map[status] : null;
  if (!hit) {
    return (
      <span className="text-[11px] italic text-muted-foreground" title={note ?? undefined}>
        not checked yet
      </span>
    );
  }
  return (
    <span className={`text-[11px] ${hit.tone}`} title={note ?? undefined}>
      {hit.label}
    </span>
  );
}

function SessionRow({
  row,
  selected,
  onSelect,
}: {
  row: ZoomSessionRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const slot = slotOf(row.start_time);
  const disagrees = roleDisagrees(row.session_role, slot);
  // Only a genuinely fetched report yields a number. Anything else is an
  // unknown, and an unknown is never rendered as a value.
  const measured = row.participants_status === "fetched" || row.participants_status === "empty";

  const attendees = measured
    ? fromNullable(row.attendees)
    : unmeasured("attendance was never fetched for this session");
  const showUp = measured
    ? showUpRate(row.attendees, row.total_registrants)
    : unmeasured("attendance was never fetched for this session");
  const unknown = <span className="text-xs italic text-muted-foreground">{NO_DATA}</span>;
  return (
    <tr
      onClick={onSelect}
      className={`border-border hover:bg-muted/50 cursor-pointer border-b last:border-b-0 [&>td]:px-3 [&>td]:py-1.5 ${
        selected ? "bg-muted/70" : ""
      }`}
    >
      <td className="nums whitespace-nowrap font-medium">{row.business_date ?? NO_DATA}</td>
      <td className="nums text-muted-foreground">{istTime(row.start_time)}</td>
      <td>
        <SlotBadge slot={slot} />
      </td>
      <td className="whitespace-nowrap">
        <RoleBadge role={row.session_role} />
        {disagrees ? (
          <span
            className="text-warning ml-1.5 text-[10px]"
            title="topic label disagrees with time slot"
          >
            topic label disagrees with time slot
          </span>
        ) : null}
      </td>

      <td className="max-w-[22rem] truncate" title={row.topic ?? undefined}>
        {row.topic ?? NO_DATA}
      </td>
      <td className="nums text-right">
        {row.total_registrants === null ? unknown : count(row.total_registrants)}
      </td>
      <td className="nums text-right font-semibold">
        <MetricValue metric={attendees} format="int" />
      </td>
      <td className="nums text-right">
        <MetricValue metric={showUp} format="percent" />
      </td>
      <td className="nums text-right text-muted-foreground">
        <MetricValue
          metric={measured ? retentionRate(row.at_30, row.attendees) : attendees}
          format="percent"
        />
      </td>
      <td className="nums text-right text-muted-foreground">
        <MetricValue
          metric={measured ? retentionRate(row.at_60, row.attendees) : attendees}
          format="percent"
        />
      </td>
      <td className="nums text-right text-muted-foreground">
        <MetricValue
          metric={measured ? retentionRate(row.at_90, row.attendees) : attendees}
          format="percent"
        />
      </td>
      <td className="text-right">
        <AttendanceStatus status={row.participants_status} note={row.participants_note} />
      </td>
      <td className="nums text-right">
        {row.invalid_rows ? (
          <span className="text-warning font-medium">{count(row.invalid_rows)}</span>
        ) : (
          <span className="text-muted-foreground">0</span>
        )}
      </td>
    </tr>
  );
}

/**
 * Afternoon and evening are reported side by side and never blended. Sessions
 * with no registrant count are listed as their own line, never summed as zero.
 */
function SlotSplit({ rows }: { rows: ZoomSessionRow[] }) {
  const slots = ["Afternoon", "Evening", "Other"] as const;
  const groups = slots
    .map((slot) => ({ slot, list: rows.filter((r) => slotOf(r.start_time) === slot) }))
    .filter((g) => g.list.length > 0);

  return (
    <section className="border-border bg-card mt-5 rounded-md border">
      <div className="border-border border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          By slot · afternoon and evening are never averaged together
        </h2>
      </div>
      {groups.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">{NO_DATA}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                <th className="text-left">Slot</th>
                <th className="text-right">Sessions</th>
                <th className="text-right">Registered</th>
                <th className="text-right">Attended (same sessions)</th>
                <th className="text-right">Show-up</th>
                <th className="text-right">60m retention</th>
                <th className="text-left">No registrant count</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(({ slot, list }) => {
                const withReg = list.filter((r) => toNum(r.total_registrants) !== null);
                const registered = sumMetrics(
                  withReg.map((r) => fromNullable(r.total_registrants)),
                );
                // Show-up must divide LIKE BY LIKE: attendees only from the
                // same sessions that reported a registrant count. Summing all
                // attendees over a partial registered base inflated this rate
                // above the headline tile and made an afternoon slot look
                // healthier than it is.
                const attended = sumMetrics(withReg.map((r) => fromNullable(r.attendees)));
                const attendedAll = sumMetrics(list.map((r) => fromNullable(r.attendees)));
                const at60 = sumMetrics(withReg.map((r) => fromNullable(r.at_60)));
                const noReg = list.length - withReg.length;
                return (
                  <tr
                    key={slot}
                    className="border-border border-b last:border-b-0 [&>td]:px-3 [&>td]:py-1.5"
                  >
                    <td className="font-medium">{slot}</td>
                    <td className="nums text-right">{count(list.length)}</td>
                    <td className="nums text-right">
                      <MetricValue metric={registered} format="int" />
                    </td>
                    <td className="nums text-right">
                      <MetricValue metric={attended} format="int" />
                    </td>
                    <td className="nums text-right">
                      <MetricValue metric={rate(attended, registered)} format="percent" />
                    </td>
                    <td className="nums text-right">
                      <MetricValue metric={rate(at60, attended, { min: 10 })} format="percent" />
                    </td>
                    <td className="text-[11px] text-muted-foreground">
                      {noReg === 0
                        ? "—"
                        : `${count(noReg)} session${noReg === 1 ? "" : "s"} left out of this row because no registration count came through. Counting everyone who attended, including those sessions: ${attendedAll.value === null ? "no data" : renderMetric(attendedAll.value, "int")}.`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
