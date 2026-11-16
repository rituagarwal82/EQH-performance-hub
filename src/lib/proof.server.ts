/**
 * THE PROOF LAYER.
 *
 * Every headline number in this engine is cross-checked, daily, against a
 * second source that cannot share its mistakes. Each check writes one
 * `reconciliations` row per day checked; the trailing window is re-checked on
 * every run because sources backfill.
 *
 * The honest limit, stated here and on /trust: offline collections have no
 * independent witness. They exist only in the accounts ledger. We check their
 * internal consistency (closed months, the settling rule) and claim nothing
 * more.
 */

import { getPg, pgInsert, pgRpc, pgSelect, pgUpdate, type PgClient } from "./pg.server";
import { graphGet } from "./meta-sync.server";
import { lastRawError, safeMessage } from "./safe-error";

export type Verdict = "match" | "tolerable" | "diverged" | "witness_unavailable";

export type ReconRow = {
  check_id: string;
  checked_at: string;
  for_date: string;
  primary_value: number | null;
  primary_source: string;
  witness_value: number | null;
  witness_source: string;
  divergence_pct: number | null;
  verdict: Verdict;
  note: string | null;
};

export type ProofRunResult = {
  status: "success" | "partial" | "error";
  rowsWritten: number;
  since: string;
  until: string;
  checks: { check_id: string; days: number; diverged: number; error: string | null }[];
  error: string | null;
};

type ProofInput = {
  date: string;
  meta_spend: number | null;
  tm_sales: number | null;
  ledger_sales: number | null;
  settled: boolean;
  leads_registered: number | null;
  zoom_registrants: number | null;
  zoom_valid_participants: number | null;
  zoom_total_attendees: number | null;
  zoom_sessions_n: number;
};

type ClosedMonth = {
  month_start: string;
  month: string;
  baseline: number;
  ledger_sales: number;
};

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function divergence(primary: number, witness: number): number | null {
  const base = Math.abs(witness) > 0 ? Math.abs(witness) : Math.abs(primary);
  if (base === 0) return 0;
  return Math.round(((primary - witness) / base) * 1000) / 10;
}

/**
 * A shared shape for the numeric checks. `tolerable` is only used where the two
 * sources legitimately measure slightly different things.
 */
function judge(opts: {
  primary: number | null;
  witness: number | null;
  matchPct: number;
  tolerablePct?: number;
}): { verdict: Verdict; divergence_pct: number | null } {
  const { primary, witness, matchPct } = opts;
  if (primary === null || witness === null) {
    return { verdict: "witness_unavailable", divergence_pct: null };
  }
  // A collapse — one side normal, the other flat zero — is never tolerable,
  // whatever the percentage arithmetic says.
  if ((primary === 0) !== (witness === 0)) {
    return { verdict: "diverged", divergence_pct: divergence(primary, witness) };
  }
  const pct = divergence(primary, witness);
  const abs = Math.abs(pct ?? 0);
  if (abs <= matchPct) return { verdict: "match", divergence_pct: pct };
  if (opts.tolerablePct !== undefined && abs <= opts.tolerablePct) {
    return { verdict: "tolerable", divergence_pct: pct };
  }
  return { verdict: "diverged", divergence_pct: pct };
}

/** Fresh, direct call to Meta for one account across the window. */
async function metaWitnessSpend(
  accountId: string,
  token: string,
  since: string,
  until: string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const page = await graphGet<{ data: { date_start: string; spend?: string }[] }>(
    `/act_${accountId}/insights`,
    {
      level: "account",
      fields: "spend",
      time_increment: "1",
      time_range: JSON.stringify({ since, until }),
      limit: "500",
    },
    token,
  );
  for (const row of page.data ?? []) {
    out[row.date_start] = (out[row.date_start] ?? 0) + Number(row.spend ?? 0);
  }
  return out;
}

/** Today's date in Asia/Kolkata — the day Meta is still accruing into. */
function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

async function checkMetaSpend(
  pg: PgClient,
  inputs: ProofInput[],
  since: string,
  until: string,
  now: string,
): Promise<{ rows: ReconRow[]; error: string | null }> {
  const token = process.env["META_ACCESS_TOKEN"];
  const primarySource = "daily_metrics (account level, active accounts)";
  const witnessSource = "Meta Graph API v21.0 /insights (live)";
  if (!token) {
    return {
      rows: inputs.map((i) => ({
        check_id: "meta_spend",
        checked_at: now,
        for_date: i.date,
        primary_value: i.meta_spend,
        primary_source: primarySource,
        witness_value: null,
        witness_source: witnessSource,
        divergence_pct: null,
        verdict: "witness_unavailable" as Verdict,
        note: "META_ACCESS_TOKEN is not set, so Meta could not be asked.",
      })),
      error: "META_ACCESS_TOKEN is not set",
    };
  }

  const accounts = await pgSelect<{ account_id: string }[]>(
    pg,
    "/ad_accounts?select=account_id&is_active=eq.true",
  );

  const witness: Record<string, number> = {};
  const failures: string[] = [];
  for (const account of accounts) {
    try {
      const byDate = await metaWitnessSpend(account.account_id, token, since, until);
      for (const [date, spend] of Object.entries(byDate)) {
        witness[date] = (witness[date] ?? 0) + spend;
      }
    } catch (e) {
      failures.push(`${account.account_id}: ${safeMessage(e)}`);
    }
  }

  // A partial witness would understate spend and manufacture a false
  // divergence, so a failed account voids the day rather than skewing it.
  const voided = failures.length > 0;

  // A day still accruing cannot be compared like for like: our stored figure is
  // a snapshot taken hours ago and Meta's answer is live, so the newest day
  // always reads as a shortfall. Only fully elapsed days are checked.
  const elapsed = inputs.filter((i) => i.date < istToday());

  const rows: ReconRow[] = elapsed.map((i) => {
    const w = voided ? null : Math.round((witness[i.date] ?? 0) * 100) / 100;
    const p = i.meta_spend === null ? null : Math.round(i.meta_spend * 100) / 100;
    const { verdict, divergence_pct } = judge({ primary: p, witness: w, matchPct: 1 });
    return {
      check_id: "meta_spend",
      checked_at: now,
      for_date: i.date,
      primary_value: p,
      primary_source: primarySource,
      witness_value: w,
      witness_source: witnessSource,
      divergence_pct,
      verdict,
      note: voided
        ? `Meta refused ${failures.length} of ${accounts.length} accounts, so the day has no complete witness: ${failures[0]}`
        : `${accounts.length} active accounts, 1% tolerance (Meta revises intraday)`,
    };
  });

  return { rows, error: failures.length ? failures.join(" | ") : null };
}

/**
 * Sales count, version 2 (2026-09-07).
 *
 * The settling rule and this check used to measure the gap against different
 * bases, so a day could be declared settled and then immediately fail. Both
 * now measure against the TagMango side, and a gap of a single sale is carried
 * rather than reported: three named causes produce one every few days without
 * anything being wrong — an instalment part-payment, a payment banked a day
 * either side of the enrolment, and an unidentified "Suspense" ledger line
 * whose payer has no email and so can never appear in TagMango.
 */
function checkSalesCount(inputs: ProofInput[], now: string): ReconRow[] {
  // Settling days are deliberately not checked: their ledger side is expected
  // to be incomplete, and a check that fires on an expected gap teaches the
  // owner to ignore it.
  return inputs
    .filter((i) => i.settled)
    .map((i) => {
      const p = i.tm_sales ?? 0;
      const w = i.ledger_sales ?? 0;
      const gap = Math.abs(p - w);
      const base = Math.max(p, 1);
      const pct = Math.round((1000 * (p - w)) / base) / 10;
      const verdict: Verdict = gap <= 1 ? "match" : Math.abs(pct) <= 20 ? "match" : "diverged";
      return {
        check_id: "sales_count",
        checked_at: now,
        for_date: i.date,
        primary_value: p,
        primary_source: "TagMango enrolments (counts_as_sale services)",
        witness_source: "Accounts ledger — New Sale Tagging (L1)",
        witness_value: w,
        divergence_pct: pct,
        verdict,
        note:
          verdict === "diverged"
            ? `Settled day, ${gap} sales apart. Beyond the known one-sale causes — instalment part-payments, a payment banked a day either side, an unidentified "Suspense" line — so this is a bookkeeping miss to chase.`
            : gap === 0
              ? "Settled day: both sources count the same sales."
              : `Settled day, one sale apart — the known instalment / banking-date / unidentified-payer gap, carried by design.`,
      };
    });
}


/**
 * Registrations is a consistency check, not an equality check. One person who
 * registers for tonight's session and tomorrow's replay is two Zoom registrant
 * rows and one CRM lead, so Zoom is structurally the larger number every day.
 * Zoom gives us per-session registrant counts only — no registrant emails — so
 * the duplication cannot be removed, and the tolerance is set wide enough that
 * only a collapse fires.
 */
const REGISTRATIONS_NOTE =
  "Zoom counts a registration per session; the CRM counts a person. Someone registering for both the live slot and the replay is two Zoom rows and one lead, so Zoom runs structurally higher — expect a gap of roughly a third. 60% tolerance: this fires on a collapse, not on the known overlap.";

function checkRegistrations(inputs: ProofInput[], now: string): ReconRow[] {
  return inputs.map((i) => {
    const p = i.leads_registered;
    const w = i.zoom_sessions_n > 0 ? (i.zoom_registrants ?? 0) : null;
    const { verdict, divergence_pct } = judge({
      primary: p,
      witness: w,
      matchPct: 60,
    });
    return {
      check_id: "registrations",
      checked_at: now,
      for_date: i.date,
      primary_value: p,
      primary_source: "CRM leads marked registered",
      witness_value: w,
      witness_source: "Zoom session registrants",
      divergence_pct,
      verdict,
      note:
        w === null
          ? "No webinar session recorded for this day, so there is nothing to compare against."
          : REGISTRATIONS_NOTE,
    };
  });
}

function checkAttendanceIntegrity(inputs: ProofInput[], now: string): ReconRow[] {
  return inputs
    .filter((i) => i.zoom_sessions_n > 0)
    .map((i) => {
      const p = i.zoom_valid_participants;
      const w = i.zoom_total_attendees;
      const { verdict, divergence_pct } = judge({ primary: p, witness: w, matchPct: 2 });
      return {
        check_id: "attendance_integrity",
        checked_at: now,
        for_date: i.date,
        primary_value: p,
        primary_source: "Distinct valid participants, counted per session",
        witness_value: w,
        witness_source: "Zoom session attendee totals",
        divergence_pct,
        verdict,
        note: "Same source, two computation paths — this catches our own aggregation bugs.",
      };
    });
}

function checkClosedMonths(months: ClosedMonth[], now: string): ReconRow[] {
  return months.map((m) => {
    const p = Number(m.baseline);
    const w = Number(m.ledger_sales);
    const { verdict, divergence_pct } = judge({ primary: p, witness: w, matchPct: 0 });
    return {
      check_id: "ledger_closed_months",
      checked_at: now,
      for_date: m.month_start,
      primary_value: p,
      primary_source: "Agreed closed-month baseline",
      witness_value: w,
      witness_source: "Accounts ledger as it stands today",
      divergence_pct,
      verdict,
      note:
        verdict === "match"
          ? `${m.month} still reads ${w} sales, as agreed.`
          : `${m.month} has moved: agreed ${p}, ledger now reads ${w}. History must never move silently.`,
    };
  });
}

type PaidDayRow = {
  business_date: string;
  collected_all: number | string;
  collected_paid_gross: number | string;
  rows_all: number | string;
};

/** A day this thin cannot evidence a coverage collapse either way. */
const PURITY_MIN_SALES = 8;

/**
 * Attribution purity, version 2 (2026-09-07). Two assertions:
 *   1. Ad-attributed collections can never exceed total collections. If they
 *      do, the join is double-counting and every ROAS on the site is wrong.
 *      No tolerance, no minimum, ever.
 *   2. Convergence — attributed cash at 95% or more of the total — means
 *      attribution has stopped discriminating between paid and organic buyers.
 *      That reads as a great number and is in fact a coverage collapse.
 *
 * Version 1 asserted (2) on every day and cried wolf on thin ones: five or
 * seven buyers who all happen to be ad-attributed is ordinary. Over the
 * trailing 60 days 66.8% of L1 cash was ad-attributed and not one day with 8
 * or more sales converged, so the arm now needs that many sales — and the
 * fortnight as a whole is checked separately, which is where a real collapse
 * would show.
 */
function checkAttributionPurity(rows: PaidDayRow[], now: string): ReconRow[] {
  const usable = rows.filter((r) => Number(r.collected_all) > 0);
  const daily = usable.map((r) => {
    const all = Number(r.collected_all);
    const paid = Number(r.collected_paid_gross);
    const n = Number(r.rows_all ?? 0);
    const share = paid / all;
    const thin = n < PURITY_MIN_SALES;
    const verdict: Verdict =
      paid > all ? "diverged" : share >= 0.95 && !thin ? "diverged" : "match";
    return {
      check_id: "attribution_purity",
      checked_at: now,
      for_date: r.business_date,
      primary_value: Math.round(paid),
      primary_source: "Ad-attributed new-sale collections (gross)",
      witness_value: Math.round(all),
      witness_source: "All L1 collections in the ledger",
      divergence_pct: Number((100 * (share - 1)).toFixed(2)),
      verdict,
      note:
        paid > all
          ? "Ad-attributed cash exceeds total cash — the lead join is duplicating ledger rows."
          : share >= 0.95
            ? thin
              ? `All of this day's L1 cash is ad-attributed, on only ${n} sale${n === 1 ? "" : "s"}. Too thin to mean anything either way; the fortnight-wide check below is the one that would catch a real collapse.`
              : "Ad-attributed cash is within 5% of all cash on a full day of sales. That is not a win: organic and instalment money is being counted as paid, so attribution coverage has collapsed."
            : `${Math.round(share * 100)}% of the day's L1 cash is ad-attributed; the rest is organic buyers and instalments on earlier sales.`,
    } satisfies ReconRow;
  });

  // The window-wide arm: thin days cannot each carry the assertion, but the
  // period as a whole can, and a genuine collapse shows here first.
  if (usable.length > 0) {
    const all = usable.reduce((s, r) => s + Number(r.collected_all), 0);
    const paid = usable.reduce((s, r) => s + Number(r.collected_paid_gross), 0);
    const share = all > 0 ? paid / all : 0;
    const last = usable[usable.length - 1]!.business_date;
    daily.push({
      check_id: "attribution_purity_window",
      checked_at: now,
      for_date: last,
      primary_value: Math.round(paid),
      primary_source: `Ad-attributed L1 cash across the last ${usable.length} selling day${usable.length === 1 ? "" : "s"}`,
      witness_value: Math.round(all),
      witness_source: "All L1 cash across the same days",
      divergence_pct: Number((100 * (share - 1)).toFixed(2)),
      verdict: share >= 0.95 ? "diverged" : "match",
      note:
        share >= 0.95
          ? `${Math.round(share * 100)}% of all L1 cash over the window is ad-attributed. Organic buyers have not disappeared, so attribution is over-claiming.`
          : `${Math.round(share * 100)}% of L1 cash over the window is ad-attributed — in line with the 67% the trailing 60 days run at.`,
    } satisfies ReconRow);
  }

  return daily;
}


export async function runProofChecks(opts: {
  since?: string | null;
  until?: string | null;
  source?: string;
}): Promise<ProofRunResult> {
  const pg = getPg();
  const today = new Date();
  const until = opts.until ?? isoDate(today);
  const since =
    opts.since ?? isoDate(new Date(new Date(until).getTime() - 6 * 24 * 60 * 60 * 1000));
  const source = opts.source ?? "proof";

  const base: ProofRunResult = {
    status: "error",
    rowsWritten: 0,
    since,
    until,
    checks: [],
    error: null,
  };

  if (!pg) return { ...base, error: "Lovable Cloud backend is not configured for this project yet." };

  const run = await pgInsert<{ id: string }[]>(pg, "sync_runs", { source, status: "running" });
  const runId = run?.[0]?.id;
  const finish = async (result: ProofRunResult) => {
    if (runId) {
      await pgUpdate(pg, "sync_runs", `id=eq.${runId}`, {
        finished_at: new Date().toISOString(),
        rows_written: result.rowsWritten,
        status: result.status,
        error: result.error,
        error_detail: result.error ? (lastRawError() ?? result.error) : null,
      });
    }
    return result;
  };

  const now = new Date().toISOString();
  let inputs: ProofInput[] = [];
  let months: ClosedMonth[] = [];
  try {
    inputs = await pgRpc<ProofInput[]>(pg, "proof_inputs", { p_start: since, p_end: until });
    months = await pgRpc<ClosedMonth[]>(pg, "proof_closed_months", {});
  } catch (e) {
    return finish({ ...base, error: safeMessage(e) });
  }

  const checks: ProofRunResult["checks"] = [];
  const all: ReconRow[] = [];
  const errors: string[] = [];

  const push = (check_id: string, rows: ReconRow[], error: string | null) => {
    all.push(...rows);
    checks.push({
      check_id,
      days: rows.length,
      diverged: rows.filter((r) => r.verdict === "diverged").length,
      error,
    });
    if (error) errors.push(`${check_id}: ${error}`);
  };

  try {
    const meta = await checkMetaSpend(pg, inputs, since, until, now);
    push("meta_spend", meta.rows, meta.error);
  } catch (e) {
    push("meta_spend", [], safeMessage(e));
  }

  push("sales_count", checkSalesCount(inputs, now), null);
  push("registrations", checkRegistrations(inputs, now), null);
  push("attendance_integrity", checkAttendanceIntegrity(inputs, now), null);
  push("ledger_closed_months", checkClosedMonths(months, now), null);

  try {
    const paidRows = await pgRpc<PaidDayRow[]>(pg, "ledger_paid_daily", {
      p_start: since,
      p_end: until,
    });
    const purity = checkAttributionPurity(paidRows ?? [], now);
    push(
      "attribution_purity",
      purity.filter((r) => r.check_id === "attribution_purity"),
      null,
    );
    push(
      "attribution_purity_window",
      purity.filter((r) => r.check_id === "attribution_purity_window"),
      null,
    );
  } catch (e) {
    push("attribution_purity", [], safeMessage(e));
  }


  // ── The harness checks. Same surface, same table, same panel: a guard that
  // needed its own screen would be a guard nobody reads.
  const pushGrouped = (rows: ReconRow[] | null) => {
    const byCheck = new Map<string, ReconRow[]>();
    for (const r of rows ?? []) {
      const list = byCheck.get(r.check_id) ?? [];
      list.push(r);
      byCheck.set(r.check_id, list);
    }
    for (const [id, list] of byCheck) push(id, list, null);
  };

  // Which accounts have working lead tracking is evidence, not an opinion:
  // re-derive it before anything measured-vs-total is judged tonight.
  try {
    await pgRpc<unknown>(pg, "refresh_lead_tracking_status", { p_days: 30 });
  } catch (e) {
    errors.push(`lead tracking status: ${safeMessage(e)}`);
  }

  for (const fn of [
    "inv_cron_manifest_rows",
    "inv_cron_alive_rows",
    // Orphan spend rows only surface in the trailing-fortnight scan on the day
    // they land; this one sweeps the whole history, every night.
    "inv_orphan_history_rows",
    // A level that stopped syncing months ago is invisible to any trailing
    // window — this one walks every day we hold, account by account.
    "inv_level_history_rows",
    // Nothing stops silently: a job that never started, and a feed that runs
    // cleanly while bringing nothing new, are both recorded as divergences.
    "inv_missed_runs_rows",
    "inv_data_recency_rows",
  ] as const) {
    try {
      pushGrouped(await pgRpc<ReconRow[]>(pg, fn, {}));
    } catch (e) {
      push(fn.replace(/_rows$/, ""), [], safeMessage(e));
    }
  }


  // The semantic invariants re-check a trailing fortnight every run, because a
  // defect that lands today may only become visible when a later day backfills.
  try {
    const invSince = isoDate(new Date(new Date(until).getTime() - 13 * 24 * 60 * 60 * 1000));
    const inv = (await pgRpc<ReconRow[]>(pg, "run_invariants", {
      p_start: invSince,
      p_end: until,
    })) ?? [];
    // The grain check is dropped for the day still accruing: account-level
    // spend syncs before the ad-level rows finish, so today always reads a
    // fraction short and the gap closes on its own by tomorrow.
    const istToday_ = istToday();
    pushGrouped(
      inv.filter((r) => !(r.check_id === "inv_grain_integrity" && r.for_date >= istToday_)),
    );
  } catch (e) {
    push("inv_semantic", [], safeMessage(e));
  }


  // I-SYM: cash from a team whose ad spend never reaches us would inflate the
  // paid ratios. The exclusion is automatic; this says it out loud each night.
  try {
    const symSince = isoDate(new Date(new Date(until).getTime() - 13 * 24 * 60 * 60 * 1000));
    pushGrouped(
      await pgRpc<ReconRow[]>(pg, "inv_spend_symmetry_rows", {
        p_start: symSince,
        p_end: until,
      }),
    );
  } catch (e) {
    push("inv_spend_symmetry", [], safeMessage(e));
  }

  // I-BASIS: the other half of the same law. I-SYM asks whether a team's spend
  // reaches us at all; this asks whether the spend side and the cash side are
  // even talking about the same team. Spend resolves a team by which ad
  // accounts it runs, so leads must too. When those two rules drifted apart the
  // first time the answer was 48.84x too high; the second time it would have
  // been ~7x too low. Three windows, because a rule change shows up on recent
  // days long before it shows up on settled history.
  try {
    const windows: Array<[string, string]> = [
      [isoDate(new Date(new Date(until).getTime() - 6 * 86400000)), until],
      [isoDate(new Date(new Date(until).getTime() - 29 * 86400000)), until],
      [isoDate(new Date(new Date(until).getTime() - 89 * 86400000)), until],
    ];
    for (const [start, end] of windows) {
      pushGrouped(await pgRpc<ReconRow[]>(pg, "inv_basis_symmetry_rows", { p_start: start, p_end: end }));
    }
  } catch (e) {
    push("inv_basis_symmetry", [], safeMessage(e));
  }

  // Every lead must carry a source decision. Without one the lead belongs to
  // nobody: its sale reads "No lead record" and its team gets no credit.
  try {
    const srcSince = isoDate(new Date(new Date(until).getTime() - 13 * 86400000));
    pushGrouped(
      await pgRpc<ReconRow[]>(pg, "inv_source_decision_rows", {
        p_start: srcSince,
        p_end: until,
      }),
    );
  } catch (e) {
    push("inv_source_decision", [], safeMessage(e));
  }


  // Spend with nothing beneath it. The level-consistency check compares an
  // account against its own campaigns, so an account that never synced a single
  // campaign row could not fail it — which is exactly how the SX era's
  // ₹1.03 crore of account-only spend sat unchecked all year. This one walks
  // the whole history, because that blind spot is historical by nature.
  try {
    pushGrouped(
      await pgRpc<ReconRow[]>(pg, "inv_unwitnessed_spend_rows", {
        p_start: "2026-01-01",
        p_end: until,
      }),
    );
  } catch (e) {
    push("inv_unwitnessed_spend", [], safeMessage(e));
  }

  // Views that read as the caller, not as their owner. Registered as a check
  // since 7 Sep but never actually called by this runner, so it had produced
  // no rows at all — a check nobody runs is not a check.
  try {
    pushGrouped(await pgRpc<ReconRow[]>(pg, "inv_view_security_invoker_rows", {}));
  } catch (e) {
    push("inv_view_security_invoker", [], safeMessage(e));
  }





  // Contract drift: a metric whose calculation changed while its recorded
  // definition stayed put is the failure this whole harness exists for — the
  // number keeps rendering and nobody is told the meaning moved.
  try {
    await pgRpc<Record<string, unknown>>(pg, "contract_drift", {});
  } catch (e) {
    push("contract_drift", [], safeMessage(e));
  }

  // Goldens last: they re-derive verified historical figures from live code,
  // so they are the check that catches a refactor changing settled history.
  try {
    const g = await pgRpc<{ pass: number; fail: number }>(pg, "run_golden_tests", {
      p_trigger: "nightly",
    });
    if (g && g.fail > 0) errors.push(`goldens: ${g.fail} verified figure(s) no longer reproduce`);
  } catch (e) {
    push("goldens", [], safeMessage(e));
  }


  let rowsWritten = 0;
  try {
    // One check may be run over several overlapping windows (basis symmetry runs
    // 7/30/90 days), so the same check and day can appear more than once in one
    // batch. The store updates on conflict, and Postgres refuses to touch the
    // same row twice in a single command — which silently killed every proof run
    // from 8 Sep. Keep the last row for each check/day before writing.
    const deduped = Array.from(
      new Map(all.map((r) => [`${r.check_id}|${r.for_date}`, r])).values(),
    );
    if (deduped.length) {
      rowsWritten = await pgRpc<number>(pg, "record_reconciliations", { p_rows: deduped });
    }
  } catch (e) {
    return finish({ ...base, checks, error: safeMessage(e) });
  }

  // Arbitration escalation: a disagreement is never left to a hover mark alone.
  // The posted value is still the precedence winner — this only asks a human to look.
  try {
    const { raiseReviewItem } = await import("./review.server");
    const { ARBITRATION_RULES } = await import("./arbitration");
    for (const c of checks) {
      if (c.diverged <= 0) continue;
      const rule = ARBITRATION_RULES.find((r) => r.checkId === c.check_id);
      if (!rule) continue;
      await raiseReviewItem(pg, {
        kind: "source_disagreement",
        refId: `${rule.id}:${until}`,
        title: `${rule.label}: two sources disagree on ${c.diverged} of ${c.days} day${c.days === 1 ? "" : "s"}`,
        detail: `Posted from ${rule.primary.source} by the arbitration rule — never averaged, never the flattering one. ${rule.rule}`,
        evidence: {
          metric: rule.id,
          check_id: c.check_id,
          diverged_days: c.diverged,
          days_checked: c.days,
          tolerance_pct: rule.tolerancePct,
          contract_version: (await import("./arbitration")).ARBITRATION_VERSION,
        },
      });
    }
  } catch {
    // Escalation must never fail a proof run.
  }

  // Calibration discipline: a check that fires more often than its declared
  // false-alarm budget stops shouting. It keeps recording; it is shown in amber
  // and left out of the headline count until a human resolves its review item.
  try {
    const over = await pgRpc<
      { check_id: string; label: string; fires: number; budget: number; expected_noise: string }[]
    >(pg, "enforce_watchdog_budgets", {});
    if (over?.length) {
      const { raiseReviewItem } = await import("./review.server");
      for (const w of over) {
        await raiseReviewItem(pg, {
          kind: "watchdog_recalibration",
          refId: w.check_id,
          title: `${w.label} is crying wolf: ${w.fires} disagreements in 30 days against a budget of ${w.budget}`,
          detail: `Expected noise for this check: ${w.expected_noise}. It has been set aside as "under review — miscalibrated": it keeps recording every day, but it no longer counts towards the headline problem count. Resolving this item returns it to service.`,
          evidence: {
            check_id: w.check_id,
            diverged_days_30d: w.fires,
            fp_budget_per_30d: w.budget,
            expected_noise: w.expected_noise,
          },
        });
      }
    }
  } catch {
    // Calibration bookkeeping must never fail a proof run either.
  }

  // Queue hygiene, last: one item per underlying issue, and an item whose check
  // has recovered closes itself. No check stops running and nothing is deleted.
  try {
    await pgRpc<Record<string, unknown>>(pg, "reconcile_review_items", {});
  } catch {
    // Tidying must never fail a proof run.
  }



  return finish({

    status: errors.length === 0 ? "success" : rowsWritten > 0 ? "partial" : "error",
    rowsWritten,
    since,
    until,
    checks,
    error: errors.length ? errors.join(" | ") : null,
  });
}
