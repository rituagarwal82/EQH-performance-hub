/** The owner's trust summary, computed as a plain server helper so the daily
 * email can use exactly the same words as the screen. */

import type { OwnerAttention, OwnerDecision, OwnerTrust, OwnerUpcoming } from "./owner-trust.functions";
import { safeMessage } from "./safe-error";
import { plainConcept, plainScriptList } from "./taxonomy";

const EMPTY: OwnerTrust = {
  configured: false,
  checkedAt: null,
  checksRun: 0,
  status: "amber",
  statusLine: "The checks could not be read, so nothing here can be called healthy.",
  attention: [],
  decisions: [],
  upcoming: [],
  error: null,
};

const inr = (n: number) =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n))}`;

const num = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

export async function computeOwnerTrust(): Promise<OwnerTrust> {

    const { getPg, pgSelect, pgRpc } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return EMPTY;

    try {
      type ProofRow = {
        check_id: string;
        label: string;
        plain: string;
        status: string;
        diverged: number;
        last_run: string | null;
        family: string;
      };
      type FeedRow = {
        feed: string;
        label: string;
        status: string;
        is_blocking: boolean;
        warning: string | null;
        warning_level: string | null;
        days_to_expiry: number | null;
        expires_at: string | null;
      };
      type GoldenRow = {
        golden_id: string;
        metric_id: string;
        pass: boolean | null;
        note: string | null;
        window_start: string;
        window_end: string;
      };
      type ItemRow = {
        id: string;
        kind: string;
        ref_id: string | null;
        title: string;
        detail: string | null;
        evidence: Record<string, unknown> | null;
      };

      type NetRow = {
        key: string;
        kind: string;
        level: string;
        text: string;
        consequence: string;
      };
      type CredRow = {
        key: string;
        label: string;
        expires_at: string | null;
        days_left: number | null;
        level: string;
        sentence: string;
      };

      const today = new Date().toISOString().slice(0, 10);
      const [checks, feeds, goldens, items, noLead, net, creds] = await Promise.all([
        pgRpc<ProofRow[]>(pg, "proof_summary", {}),
        pgRpc<FeedRow[]>(pg, "feed_health_rows", {}),
        pgRpc<GoldenRow[]>(pg, "golden_status", {}),
        pgSelect<ItemRow[]>(
          pg,
          "/review_items?select=id,kind,ref_id,title,detail,evidence&status=eq.open&kind=in.(concept_proposal,owner_action,new_ad_account,script_tags,script_transcript_missing,concept_transition,source_disagreement)&order=created_at.asc",
        ),
        // This year only, first course only, read from the stored attribution.
        pgRpc<{ buyers?: number; sales?: number; collected?: number }>(
          pg,
          "nolead_owner_summary",
          { p_since: `${today.slice(0, 4)}-01-01` },
        ).catch(() => ({}) as { buyers?: number; collected?: number }),
        // The safety net is evaluated HERE, on this request — a job that never
        // ran cannot be noticed by a check that the same scheduler was meant
        // to start.
        pgRpc<NetRow[]>(pg, "safety_net_rows", {}).catch(() => [] as NetRow[]),
        pgRpc<CredRow[]>(pg, "credential_alert_rows", {}).catch(() => [] as CredRow[]),
      ]);

      const attention: OwnerAttention[] = [];

      // The daily email is itself a thing that can stop silently.
      try {
        const mail = await pgSelect<{ status: string; business_date: string }[]>(
          pg,
          "/daily_email_log?select=status,business_date&order=business_date.desc&limit=1",
        );
        const m = mail?.[0];
        if (m?.status === "failed") {
          attention.push({
            key: "daily-email",
            level: "amber",
            text: "Your daily status email did not go out this morning, so nothing below reached your inbox.",
          });
        } else if (m?.status === "no_key") {
          attention.push({
            key: "daily-email-key",
            level: "amber",
            text: "Your daily status email cannot be sent yet: the email key has not been added.",
          });
        }
        // Silence alarm: nothing sent for more than 26 hours is a fault, even
        // if no run ever logged a failure.
        const lastSent = await pgSelect<{ sent_at: string; business_date: string }[]>(
          pg,
          "/daily_email_log?select=sent_at,business_date&status=eq.sent&order=sent_at.desc&limit=1",
        );
        const ls = lastSent?.[0];
        const ageH = ls?.sent_at ? (Date.now() - new Date(ls.sent_at).getTime()) / 3600000 : Infinity;
        if (ageH > 26) {
          attention.push({
            key: "daily-email-silent",
            level: "amber",
            text: `No daily status email has gone out for more than 26 hours${ls ? ` — the last one covered ${ls.business_date}` : ""}.`,
          });
          const ref = `last-sent:${ls?.business_date ?? "never"}`;
          const open = await pgSelect<{ id: string }[]>(
            pg,
            `/review_items?select=id&kind=eq.daily_email_silent&ref_id=eq.${encodeURIComponent(ref)}`,
          ).catch(() => [{ id: "skip" }]);
          if ((open ?? []).length === 0) {
            const { pgInsert } = await import("./pg.server");
            await pgInsert(pg, "review_items", {
              kind: "daily_email_silent",
              ref_id: ref,
              title: "The daily status email has not gone out for more than 26 hours",
              detail: ls ? `Last sent email covered ${ls.business_date}, sent ${ls.sent_at}.` : "No daily email has ever been recorded as sent.",
              evidence: { last_sent: ls ?? null, hours: Number.isFinite(ageH) ? Math.round(ageH) : null },
            }).catch(() => undefined);
          }
        }
      } catch {
        // Never let the email check decide whether the screen loads.
      }

      // A money figure that no longer reproduces is the loudest thing there is.
      const failing = (goldens ?? []).filter((g) => g.pass === false);
      if (failing.length > 0) {
        attention.push({
          key: "goldens",
          level: "amber",
          text:
            failing.length === 1
              ? `One signed-off figure no longer comes out the same: ${plainGolden(failing[0]!)}.`
              : `${failing.length} signed-off figures no longer come out the same: ${failing
                  .map((g) => plainGolden(g))
                  .join("; ")}.`,
        });
      }

      // A blocking feed that stopped means today's money figures are not today's.
      for (const f of feeds ?? []) {
        if (f.is_blocking && (f.status === "broken" || f.status === "stale")) {
          attention.push({
            key: `feed-${f.feed}`,
            level: f.status === "broken" ? "red" : "amber",
            text:
              f.status === "broken"
                ? `${f.label} has stopped arriving, so today's figures are not up to date.`
                : `${f.label} is behind, so today's figures may be incomplete.`,
          });
        }
      }

      // Two sources disagreeing on money is an owner-level fact.
      const MONEY_CHECKS = new Set([
        "sales_count",
        "inv_spend_symmetry",
        "attribution_purity",
        "inv_ledger_vs_tagmango_silence",
      ]);
      for (const c of checks ?? []) {
        if (c.status === "diverged" && MONEY_CHECKS.has(c.check_id)) {
          attention.push({ key: `check-${c.check_id}`, level: "amber", text: c.plain });
        }
      }

      // A job that never started, and a feed that runs but brings nothing new,
      // are both silent failures. Credential warnings live in "Coming up"
      // below, so they are skipped here.
      for (const n of net ?? []) {
        if (n.kind === "credential") continue;
        attention.push({
          key: n.key,
          level: n.level === "red" ? "red" : "amber",
          text: `${n.text} While that lasts, ${n.consequence}.`,
        });
      }



      const decisions: OwnerDecision[] = [];
      // Draft ad scripts are HELD: they wait on the angle library and the
      // ideal-client evidence, and nothing thin is attached to a decision.
      const proposals = (items ?? []).filter((i) => i.kind === "concept_proposal");
      for (const p of proposals) {
        const ev = p.evidence ?? {};
        const titles = (ev["script_titles"] as string[] | undefined) ?? [];
        const codes = (ev["script_codes"] as string[] | undefined) ?? [];
        const named = (titles.length ? titles : codes).map((t) => ({ title: t }));
        decisions.push({
          id: p.id,
          key: p.id,
          control: "yes_no",
          title: "Start testing a new ad idea?",
          sentence: `${plainConcept(
            String(ev["persona"] ?? ""),
            String(ev["pain"] ?? ""),
            String(ev["promise"] ?? ""),
          )}${
            named.length
              ? ` — ${named.length} script${named.length === 1 ? "" : "s"} ready: ${plainScriptList(named)}`
              : ""
          }. Yes starts it as a test; no drops it.`,
        });
      }
      for (const i of (items ?? []).filter((x) => x.kind === "script_tags")) {
        decisions.push({
          id: i.id,
          key: i.id,
          control: "yes_no",
          title: i.title,
          sentence: `${i.detail ?? "Machine-read tags waiting for your yes."} Yes settles it; no sends it back to be read again.`,
        });
      }
      for (const i of (items ?? []).filter((x) => x.kind === "script_transcript_missing")) {
        decisions.push({
          id: i.id,
          key: i.id,
          control: "yes_no",
          title: i.title,
          sentence: `${i.detail ?? "A script in the registry has no words stored, so nothing can be matched to it."} Yes marks it handled once the words are in; no drops the script.`,
        });
      }
      for (const i of (items ?? []).filter((x) => x.kind === "concept_transition")) {
        decisions.push({
          id: i.id,
          key: i.id,
          control: "yes_no",
          title: i.title,
          sentence: `${i.detail ?? i.title} Yes applies the change; no leaves it as it is.`,
        });
      }
      for (const i of (items ?? []).filter((x) => x.kind === "source_disagreement")) {
        decisions.push({
          id: i.id,
          key: i.id,
          control: "yes_no",
          title: i.title,
          sentence: i.detail ?? i.title,
        });
      }
      for (const i of (items ?? []).filter((x) => x.kind === "new_ad_account")) {
        decisions.push({
          id: i.id,
          key: i.id,
          control: "yes_no",
          title: "Which team runs this ad account?",
          sentence: `${i.title} — until this is answered, its spend sits outside every team's cost figures.`,
        });
      }
      for (const i of (items ?? []).filter((x) => x.kind === "owner_action")) {
        decisions.push({
          id: i.id,
          key: i.id,
          control: "yes_no",
          title: i.title,
          sentence: i.detail ?? i.title,
        });
      }
      const noLeadTotal = num(noLead?.buyers);
      if (noLeadTotal > 0) {
        decisions.push({
          id: null,
          key: "nolead",
          control: "open",
          href: "/queue",
          title: "Where did these buyers come from?",
          sentence: `This year, ${noLeadTotal} first-course buyers worth ${inr(num(noLead?.collected))} never appear as a registration, so their source is unknown — open the list to say where they came from.`,
        });
      }

      // Coming up: every connection with a known expiry, from 45 days out, in
      // one place, each saying what stops if it lapses.
      const upcoming: OwnerUpcoming[] = [];
      for (const c of creds ?? []) {
        if (c.level !== "warning" && c.level !== "critical") continue;
        upcoming.push({ key: `cred-${c.key}`, days: c.days_left, text: c.sentence });
      }
      if (upcoming.length === 0) {
        const meta = (feeds ?? []).find((f) => f.feed === "meta_ads");
        const d = meta?.days_to_expiry;
        if (d !== null && d !== undefined && d <= 45) {
          upcoming.push({
            key: "meta-token",
            days: d,
            text: `The Meta connection expires in ${d} day${d === 1 ? "" : "s"}${
              meta?.expires_at ? ` (${meta.expires_at})` : ""
            }. Ad spend stops arriving that day unless it is renewed.`,
          });
        }
      }

      const lastRun = (checks ?? [])
        .map((c) => c.last_run)
        .filter((v): v is string => Boolean(v))
        .sort()
        .at(-1) ?? null;

      const red = attention.some((a) => a.level === "red");
      const status: OwnerTrust["status"] = red ? "red" : attention.length > 0 ? "amber" : "green";
      const when = lastRun
        ? new Date(lastRun).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })
        : null;
      const statusLine =
        status === "green"
          ? `Everything arrived on time and every number checks out${when ? ` (last checked ${when})` : ""}.`
          : attention.length === 1
            ? `One thing needs attention: ${attention[0]!.text}`
            : `${attention.length} things need attention — they are listed below.`;

      return {
        configured: true,
        checkedAt: lastRun,
        checksRun: (checks ?? []).length,
        status,
        statusLine,
        attention,
        decisions,
        upcoming,
        error: null,
      };
    } catch (e) {
      return { ...EMPTY, configured: true, error: safeMessage(e) };
    }
}


/** A signed-off figure, said the way the owner signed it. */
function plainGolden(g: { metric_id: string; window_start: string; window_end: string }): string {
  const LABEL: Record<string, string> = {
    sales_per_1000_leads: "sales per 1,000 registrations",
    paid_l1_collected_gross: "first-course cash from paid traffic",
    all_tier_collected: "all money collected",
    l1_collected_all_sources: "first-course cash from every source",
    cost_per_sale: "cost per sale",
    cost_per_registration: "cost per registration",
    meta_spend: "Meta spend",
    ledger_l1_new_sales: "first-course sales",
    cohort_return_d90: "90-day return",
  };
  const name =
    LABEL[g.metric_id] ??
    (g.metric_id.startsWith("agency_") ? "an agency figure" : g.metric_id.replace(/_/g, " "));
  return `${name} for ${g.window_start.slice(0, 7)}`;
}

