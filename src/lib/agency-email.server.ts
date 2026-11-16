/**
 * THE TWO EMAILS TO SABHI DIGITAL — the first reports that leave the business.
 *
 * Guard rails, all enforced here before anything can send:
 * - Sabhi's own traffic only: women whose FIRST registration came through a
 *   Sabhi advertisement. The account is taken from the advertisement, never
 *   from the account field on the registration (it stopped being written on
 *   21 Sep). Accounts 587640350334915 and 699110549552181 are excluded by
 *   number in the database functions.
 * - Return = accounts-sheet cash with 18% GST removed, divided by spend. The
 *   platform's own purchase counts are never read.
 * - No other agency is named, compared or summed. None of our internal figures.
 * - A money figure that can still grow prints as a ceiling in words.
 */

import { esc, headingHtml, inr, int, type Section } from "./email-blocks.server";
import { getPg, pgRpc, pgSelect, pgUpsert } from "./pg.server";
import { safeMessage } from "./safe-error";

export const AGENCY_TO = ["aditya@sabhidigital.com"];
export const OWNER_CC = ["rituagarwal82@gmail.com"];

const GST = 1.18;
const TARGET_SPEND_DAY = 75000;
const TARGET_RETURN_LOW = 0.6;
const TARGET_RETURN_HIGH = 0.7;
const MIN_BASE_PCT = 20;
const MIN_SALES_VERDICT = 8;
const AD_DATA_FLOOR = "2026-07-01";
const DAILY_WORD_CEILING = 300;

const OTHER_AGENCY_WORDS = /\b(rajdeep|parami|scalex|scale x|in-house)\b/i;
const PLATFORM_PURCHASE_WORDS = /\b(purchases? (reported|event)|meta purchases?|pixel purchases?)\b/i;

type Bucket = "1249430309131428" | "1109475161619539" | "1488704194840585" | "google" | "meta_unidentified";

type ChainRow = {
  bucket: Bucket;
  spend: number | null;
  clicks: number | null;
  page_views: number | null;
  registrations: number;
  attended: number;
  at_price: number;
  buyers: number;
  cash: number | null;
  last_spend: string | null;
};

type AdRow = {
  ad_id: string;
  ad_name: string | null;
  account_id: string;
  spend: number;
  page_views: number;
  registrations: number;
  buyers: number;
  cash: number | null;
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const shift = (d: string, days: number) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

const pretty = (d: string, withDay = false) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
    ...(withDay ? { weekday: "long" } : {}),
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });

const x2 = (n: number) => `${n.toFixed(2)}x`;

async function chain(start: string, end: string): Promise<ChainRow[]> {
  const pg = getPg();
  if (!pg) throw new Error("backend not configured");
  const rows = (await pgRpc<ChainRow[]>(pg, "sabhi_chain", { p_start: start, p_end: end })) ?? [];
  return rows.map((r) => ({
    ...r,
    spend: num(r.spend),
    clicks: num(r.clicks),
    page_views: num(r.page_views),
    registrations: Number(r.registrations ?? 0),
    attended: Number(r.attended ?? 0),
    at_price: Number(r.at_price ?? 0),
    buyers: Number(r.buyers ?? 0),
    cash: num(r.cash),
  }));
}

async function ads(start: string, end: string): Promise<AdRow[]> {
  const pg = getPg();
  if (!pg) throw new Error("backend not configured");
  const rows = (await pgRpc<AdRow[]>(pg, "sabhi_ads", { p_start: start, p_end: end })) ?? [];
  return rows.map((r) => ({
    ...r,
    spend: Number(r.spend ?? 0),
    page_views: Number(r.page_views ?? 0),
    registrations: Number(r.registrations ?? 0),
    buyers: Number(r.buyers ?? 0),
    cash: num(r.cash),
  }));
}

type Totals = {
  spend: number;
  clicks: number;
  pageViews: number;
  regs: number;
  attended: number;
  atPrice: number;
  buyers: number;
  cash: number;
};

/** Meta only: Google's pre-pause buyers never sit inside the Meta return. */
function metaTotal(rows: ChainRow[]): Totals {
  return total(rows.filter((r) => r.bucket !== "google"));
}

/** Ads that share a name get a short tag so they read as separate ads. */
function adLabeller(rows: { ad_id: string; ad_name: string | null }[]): (r: { ad_id: string; ad_name: string | null }) => string {
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const n = (r.ad_name ?? r.ad_id).trim();
    groups.set(n, [...(groups.get(n) ?? []), r.ad_id]);
  }
  // Ad ids share a long account suffix, so the tag is the shortest run of
  // digits just before that shared tail that tells the group apart.
  const tagOf = new Map<string, string>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    let tail = 0;
    const minLen = Math.min(...ids.map((i) => i.length));
    while (tail < minLen && new Set(ids.map((i) => i.slice(i.length - tail - 1))).size === 1) tail += 1;
    for (let w = 3; w <= minLen - tail; w += 1) {
      const tags = ids.map((i) => i.slice(i.length - tail - w, i.length - tail));
      if (new Set(tags).size === ids.length || w === minLen - tail) {
        ids.forEach((id, k) => tagOf.set(id, tags[k]!));
        break;
      }
    }
  }
  return (r) => {
    const n = (r.ad_name ?? r.ad_id).trim();
    const t = tagOf.get(r.ad_id);
    return t ? `${n} [ad ${t}]` : n;
  };
}

/** Buyers split so the total always reconciles; nobody unplaced is dropped. */
function buyerLines(rows: ChainRow[], final: boolean): string[] {
  const get = (b: Bucket) => rows.find((r) => r.bucket === b);
  const out: string[] = [];
  let n = 0;
  let c = 0;
  for (const b of ["1249430309131428", "1109475161619539", "1488704194840585"] as Bucket[]) {
    const r = get(b);
    if (!r || r.buyers === 0) continue;
    out.push(`  ${ACCOUNT_LABEL[b]}: ${int(r.buyers)} paid, ${cashText(r.cash ?? 0, final)}`);
    n += r.buyers;
    c += r.cash ?? 0;
  }
  const u = get("meta_unidentified");
  out.push(`  Sabhi Meta, advertisement or account not identified: ${int(u?.buyers ?? 0)} paid, ${cashText(u?.cash ?? 0, final)}`);
  n += u?.buyers ?? 0;
  c += u?.cash ?? 0;
  const g = get("google");
  out.push(`  Google — registered before the Google pause (not in the Meta return): ${int(g?.buyers ?? 0)} paid, ${cashText(g?.cash ?? 0, final)}`);
  n += g?.buyers ?? 0;
  c += g?.cash ?? 0;
  out.push(`  Total Sabhi-attributed: ${int(n)} paid, ${cashText(c, final)} (accounts sheet)`);
  return out;
}

function total(rows: ChainRow[]): Totals {
  const t: Totals = { spend: 0, clicks: 0, pageViews: 0, regs: 0, attended: 0, atPrice: 0, buyers: 0, cash: 0 };
  for (const r of rows) {
    t.spend += r.spend ?? 0;
    t.clicks += r.clicks ?? 0;
    t.pageViews += r.page_views ?? 0;
    t.regs += r.registrations;
    t.attended += r.attended;
    t.atPrice += r.at_price;
    t.buyers += r.buyers;
    t.cash += r.cash ?? 0;
  }
  return t;
}

// ── Settlement: only money lags ──────────────────────────────────────────────

type LedgerState = {
  /** Last successful accounts-sheet read. */
  lastRead: Date | null;
  /** True when the sheet has not been read successfully for over 48 hours. */
  stale: boolean;
};

async function ledgerState(asOf: Date): Promise<LedgerState> {
  const pg = getPg();
  if (!pg) throw new Error("backend not configured");
  const rows = await pgSelect<{ finished_at: string }[]>(
    pg,
    `/sync_runs?select=finished_at&source=eq.ledger&status=in.(ok,success,success_no_yield)&finished_at=lte.${asOf.toISOString()}&order=finished_at.desc&limit=1`,
  ).catch(() => []);
  const lastRead = rows?.[0]?.finished_at ? new Date(rows[0].finished_at) : null;
  const stale = !lastRead || asOf.getTime() - lastRead.getTime() > 48 * 3600 * 1000;
  return { lastRead, stale };
}

/** Money for business day D is final once the 5 p.m. read of D+1 has run. */
function moneyFinal(day: string, ledger: LedgerState): boolean {
  if (!ledger.lastRead) return false;
  const cutoff = new Date(`${shift(day, 1)}T11:30:00Z`);
  return ledger.lastRead.getTime() >= cutoff.getTime();
}

// ── Formatting with the refusals built in ───────────────────────────────────

const per100 = (num_: number, base: number) =>
  base < MIN_BASE_PCT ? `base too small (${int(base)})` : `${Math.round((num_ / base) * 100)}`;

const cashText = (v: number, final: boolean) => (final ? inr(v) : `${inr(v)} or more`);
const costText = (spend: number, n: number, final: boolean) =>
  n === 0 ? (final ? "no sales" : "no sales yet") : final ? inr(spend / n) : `${inr(spend / n)} or better`;
const returnText = (cash: number, spend: number, final: boolean) =>
  spend <= 0 ? "no spend" : final ? x2(cash / GST / spend) : `${x2(cash / GST / spend)} or more`;

type ChainLine = { label: string; a: string; b: string; final: string; source: string };

function chainTable(
  y: Totals,
  w: Totals,
  yFinal: boolean,
  wFinal: boolean,
  suppressMoney: boolean,
): ChainLine[] {
  const fin = (moneyRow: boolean) =>
    !moneyRow ? "final" : yFinal && wFinal ? "final" : yFinal ? "7 days: not yet" : "not yet";
  const lines: ChainLine[] = [
    { label: "Money spent", a: inr(y.spend), b: inr(w.spend), final: "final", source: "Meta Ads" },
    { label: "Clicked", a: int(y.clicks), b: int(w.clicks), final: "final", source: "Meta Ads" },
    { label: "Reached the page", a: int(y.pageViews), b: int(w.pageViews), final: "final", source: "Meta Ads" },
    { label: "Registered", a: int(y.regs), b: int(w.regs), final: "final", source: "our registration records" },
    {
      label: "Registered per 100 page views",
      a: per100(y.regs, y.pageViews),
      b: per100(w.regs, w.pageViews),
      final: "final",
      source: "registration records ÷ Meta Ads",
    },
    { label: "Turned up", a: int(y.attended), b: int(w.attended), final: "final", source: "Zoom" },
    {
      label: "Show-up per 100 registered",
      a: per100(y.attended, y.regs),
      b: per100(w.attended, w.regs),
      final: "final",
      source: "Zoom ÷ registration records",
    },
    {
      label: "Still there when the price came",
      a: int(y.atPrice),
      b: int(w.atPrice),
      final: "final",
      source: "Zoom (in the room 123+ minutes after it opened)",
    },
  ];
  if (!suppressMoney) {
    lines.push(
      {
        label: "Women who paid",
        a: yFinal ? int(y.buyers) : `${int(y.buyers)} or more`,
        b: wFinal ? int(w.buyers) : `${int(w.buyers)} or more`,
        final: fin(true),
        source: "accounts sheet",
      },
      {
        label: "Cash collected",
        a: cashText(y.cash, yFinal),
        b: cashText(w.cash, wFinal),
        final: fin(true),
        source: "accounts sheet",
      },
    );
  }
  lines.push({
    label: "Cost per registration",
    a: y.regs > 0 ? inr(y.spend / y.regs) : "no registrations",
    b: w.regs > 0 ? inr(w.spend / w.regs) : "no registrations",
    final: "final",
    source: "Meta Ads ÷ registration records",
  });
  return lines;
}

function chainText(lines: ChainLine[], ha: string, hb: string): string[] {
  const out = [`  ${"".padEnd(32)}${ha.padEnd(18)}${hb.padEnd(20)}Final?   Source`];
  for (const l of lines) {
    out.push(`  ${l.label.padEnd(32)}${l.a.padEnd(18)}${l.b.padEnd(20)}${l.final.padEnd(9)}${l.source}`);
  }
  return out;
}

function chainHtml(lines: ChainLine[], ha: string, hb: string): string {
  const th = "padding:4px 6px;text-align:right;white-space:nowrap;color:#666666;font-weight:600";
  const td = "padding:4px 6px;text-align:right;white-space:nowrap";
  return (
    `<table role="presentation" style="border-collapse:collapse;font-size:13px;width:100%">` +
    `<tr><th style="padding:4px 6px;text-align:left"></th><th style="${th}">${esc(ha)}</th><th style="${th}">${esc(hb)}</th><th style="${th}">Final?</th><th style="${th};text-align:left">Source</th></tr>` +
    lines
      .map(
        (l) =>
          `<tr style="border-top:1px solid #eeeeee"><td style="padding:4px 6px">${esc(l.label)}</td><td style="${td}"><strong>${esc(l.a)}</strong></td><td style="${td}"><strong>${esc(l.b)}</strong></td><td style="${td};color:#666666">${esc(l.final)}</td><td style="padding:4px 6px;color:#666666;font-size:12px">${esc(l.source)}</td></tr>`,
      )
      .join("") +
    `</table>`
  );
}

// ── Shared blocks ───────────────────────────────────────────────────────────

const ACCOUNT_LABEL: Record<string, string> = {
  "1249430309131428": "Main Meta account (1249430309131428)",
  "1109475161619539": "Second Meta account (1109475161619539)",
  "1488704194840585": "Third Meta account (1488704194840585)",
};

function accountBlock(
  rows: ChainRow[],
  monthRows: ChainRow[],
  windowLabel: string,
  final: boolean,
  suppressMoney: boolean,
  showReturn = true,
): string[] {
  const lines: string[] = [];
  const get = (b: Bucket) => rows.find((r) => r.bucket === b);
  const monthSpend = (b: Bucket) => monthRows.find((r) => r.bucket === b)?.spend ?? 0;
  for (const b of ["1249430309131428", "1109475161619539", "1488704194840585"] as Bucket[]) {
    const r = get(b);
    const label = ACCOUNT_LABEL[b];
    if (!r || (r.spend ?? 0) === 0) {
      if (monthSpend(b) === 0) {
        lines.push(`- ${label}: no spend this month.`);
      } else {
        lines.push(`- ${label}: no spend ${windowLabel}.`);
      }
      if (r && r.buyers > 0 && !suppressMoney) {
        lines.push(
          `  ${r.buyers} ${r.buyers === 1 ? "woman" : "women"} who first registered through it earlier paid ${windowLabel} (${cashText(r.cash ?? 0, final)}, accounts sheet).`,
        );
      }
      continue;
    }
    const money = suppressMoney
      ? ""
      : showReturn
        ? ` · ${int(r.buyers)} paid · ${cashText(r.cash ?? 0, final)} collected · return ${returnText(r.cash ?? 0, r.spend ?? 0, final)} · cost per sale ${costText(r.spend ?? 0, r.buyers, final)}`
        : ` · ${int(r.buyers)} paid`;
    const att = showReturn ? "" : ` · ${int(r.attended)} turned up (Zoom)`;
    lines.push(
      `- ${label}: ${inr(r.spend ?? 0)} spent (Meta Ads) · ${int(r.registrations)} registered (our records)${att}${money}.`,
    );
  }
  const g = get("google");
  const gLast = g?.last_spend ? pretty(g.last_spend) : "26 August";
  lines.push(`- Google Ads: paused — last spent on ${gLast} 2026.`);
  if (g && g.buyers > 0 && !suppressMoney) {
    lines.push(
      `  ${g.buyers} ${g.buyers === 1 ? "woman" : "women"} who registered through Google before the pause paid ${windowLabel} (${cashText(g.cash ?? 0, final)}, accounts sheet). Registered before the Google pause — earlier advertising, not current activity, and kept out of the Meta return.`,
    );
  }
  const u = get("meta_unidentified");
  if (u && u.buyers > 0 && !suppressMoney) {
    lines.push(
      `- Sabhi Meta, advertisement not identified: ${u.buyers} ${u.buyers === 1 ? "woman" : "women"} paid ${windowLabel} (${cashText(u.cash ?? 0, final)}, accounts sheet) whose registration named a Sabhi campaign but no advertisement, so no account can be given.`,
    );
  }
  lines.push(
    "- The Page Likes account (699110549552181) is not in these figures: it runs no form, so it cannot produce registrations.",
  );
  return lines;
}

const DISCREPANCY_TITLE = "IF ANY NUMBER HERE LOOKS WRONG, PLEASE REPLY AND TELL US.";
const DISCREPANCY_BODY =
  "We would rather be corrected than be confidently wrong. These reports are built from our own records, and our records have gaps we know about and gaps we do not. One reply from you saying this does not match what we see is how we find the second kind — and it makes the whole system better for both of us. Nothing about your work is ever judged on a figure you have told us is wrong.";

const discrepancyText = () => ["", "", DISCREPANCY_TITLE, "", DISCREPANCY_BODY.toUpperCase(), "", ""];
const discrepancyHtml = () =>
  `<div style="margin-top:22px;padding-top:14px;border-top:2px solid #111111;font-size:19px;font-weight:700;line-height:1.45">${esc(DISCREPANCY_TITLE)}<div style="margin-top:8px;font-size:17px">${esc(DISCREPANCY_BODY)}</div></div>`;

const DEFINITIONS = [
  "DEFINITIONS",
  "- Sabhi traffic: women whose first registration came through a Sabhi advertisement. The account is taken from the advertisement she clicked.",
  "- Cash collected: money in our accounts sheet for new membership sales, all payment routes, as received.",
  "- Return: cash collected with 18% GST removed, divided by money spent. The ad platform's own purchase counts are never used.",
  "- Turned up: joined a live session within 7 days of registering. Still there when the price came: still in the room 123 minutes or more after it opened (the price is spoken at minute 107 of the recording; the room opens about 16 minutes before recording). Time watched is not used — only when she left.",
  "- \"or more\" / \"or better\": payments for that day are still being posted, and posting only ever adds, so the final figure can only improve.",
];

async function openItems(): Promise<{ ord: number; raised_on: string; body: string }[]> {
  const pg = getPg();
  if (!pg) return [];
  return (
    (await pgSelect<{ ord: number; raised_on: string; body: string }[]>(
      pg,
      `/agency_open_items?select=ord,raised_on,body&agency_code=eq.SD&status=eq.open&order=raised_on.asc,ord.asc`,
    ).catch(() => [])) ?? []
  );
}

async function recentCorrections(since: string): Promise<string[]> {
  const pg = getPg();
  if (!pg) return [];
  const rows =
    (await pgSelect<{ title: string; resolved_note: string | null }[]>(
      pg,
      `/review_items?select=title,resolved_note&kind=eq.agency_correction&status=eq.resolved&resolved_at=gte.${since}&order=resolved_at.asc`,
    ).catch(() => [])) ?? [];
  return rows.map((r) => `- ${r.title}${r.resolved_note ? ` — ${r.resolved_note}` : ""}`);
}

// ── Refusals ────────────────────────────────────────────────────────────────

function refusals(text: string, table: ChainLine[] | null): string[] {
  const out: string[] = [];
  if (OTHER_AGENCY_WORDS.test(text)) out.push("mentions another agency");
  if (PLATFORM_PURCHASE_WORDS.test(text)) out.push("carries an ad-platform purchase figure");
  if (table && table.some((l) => !l.source.trim())) out.push("a figure has no source label");
  return out;
}

const countWords = (lines: string[]) =>
  lines.join(" ").split(/\s+/).filter((w) => /[A-Za-z0-9₹]/.test(w)).length;

export type ComposedAgency = {
  kind: "daily" | "weekly";
  periodKey: string;
  subject: string;
  text: string;
  html: string;
  proseWords?: number;
  refusals: string[];
};

function assemble(sections: Section[]): string {
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:640px">${sections
    .map((s) => `<div style="margin-bottom:14px">${s.html}</div>`)
    .join("")}</div>`;
}

const plainSection = (lines: string[], heading?: string): Section => ({
  text: heading ? [heading.toUpperCase(), ...lines] : lines,
  html:
    (heading ? headingHtml(heading) : "") +
    lines.map((l) => (l === "" ? '<div style="height:8px"></div>' : `<div>${esc(l)}</div>`)).join(""),
});

// ── DAILY ───────────────────────────────────────────────────────────────────

export async function composeAgencyDaily(day: string, asOf = new Date()): Promise<ComposedAgency> {
  const monthStart = `${day.slice(0, 7)}-01`;
  const wStart = shift(day, -6);
  const [yRows, wRows, mRows, ledger] = await Promise.all([
    chain(day, day),
    chain(wStart, day),
    chain(monthStart, day),
    ledgerState(asOf),
  ]);
  const y = total(yRows);
  const w = total(wRows);
  const m = total(mRows);
  const wMeta = metaTotal(wRows);
  const mMeta = metaTotal(mRows);
  const yFinal = moneyFinal(day, ledger);
  const wFinal = yFinal; // the 7-day window ends on the same day
  const suppress = ledger.stale;
  const days = Number(day.slice(8, 10));

  const stamp = [
    "Sabhi Digital — Meta accounts 1249430309131428 and 1109475161619539, plus Google Ads (paused).",
    `Day covered: ${pretty(day, true)}. Last 7 days: ${pretty(wStart)} to ${pretty(day)}.`,
    suppress
      ? "Spend, registrations and attendance are final. Money is not shown: our accounts sheet has not been read for over 48 hours."
      : yFinal
        ? "Every figure below is final, money included."
        : "Spend, registrations and attendance are final. Money is still being posted, so money figures can only rise.",
  ];

  const mRet = mMeta.spend > 0 ? mMeta.cash / GST / mMeta.spend : null;
  const monthLines = [
    `Spend ${inr(m.spend)} over ${days} days, ${inr(m.spend / days)} a day (Meta Ads) — target ${inr(TARGET_SPEND_DAY)} a day.`,
    suppress
      ? "Return: not shown until the accounts sheet is read again."
      : `Return ${mRet === null ? "no spend" : yFinal ? x2(mRet) : `${x2(mRet)} or more`} (Meta only; accounts sheet, GST removed) — target ${x2(TARGET_RETURN_LOW)} to ${x2(TARGET_RETURN_HIGH)}. ${int(m.buyers)} women paid in all, ${cashText(m.cash, yFinal)} collected.`,
  ];

  const avgSpend = w.spend / 7;
  const ordinary = avgSpend > 0 && Math.abs(y.spend - avgSpend) / avgSpend <= 0.3;
  const wRet = wMeta.spend > 0 ? wMeta.cash / GST / wMeta.spend : null;
  const opening = [
    suppress
      ? `The last 7 days brought ${int(w.regs)} registrations at ${w.regs > 0 ? inr(w.spend / w.regs) : "no"} each (our records, Meta Ads).`
      : `The last 7 days returned ${wRet === null ? "nothing on no spend" : wFinal ? x2(wRet) : `${x2(wRet)} or more`} on ${inr(w.spend)} spent (Meta only; accounts sheet, GST removed; Meta Ads).`,
    ordinary
      ? `Yesterday was an ordinary day: spend of ${inr(y.spend)} sat within the usual range of the week.`
      : `Yesterday was not an ordinary day: spend of ${inr(y.spend)} against ${inr(avgSpend)} a day over the week.`,
  ];

  const table = chainTable(y, w, yFinal, wFinal, suppress);
  const account = accountBlock(yRows, mRows, "yesterday", yFinal, suppress, false);
  const items = await openItems();
  const question = items[0]
    ? [`${items[0].body} (first asked ${pretty(items[0].raised_on)})`]
    : ["Nothing open from us today."];
  const corr = await recentCorrections(`${shift(day, -1)}T00:00:00Z`);
  const corrections = corr.length > 0 ? corr : ["None since the last report."];

  const subjRet = suppress || wRet === null ? "" : ` · 7-day return ${wFinal ? x2(wRet) : `${x2(wRet)}+`}`;
  const subject = `Sabhi daily — ${pretty(day)} · ${inr(y.spend)} spent · ${int(y.regs)} registered${subjRet}`;

  const sections: Section[] = [
    plainSection(stamp),
    plainSection(monthLines, "Month to date against target"),
    plainSection(opening),
    {
      text: ["THE CHAIN", ...chainText(table, "Yesterday", "Last 7 days")],
      html: headingHtml("The chain") + chainHtml(table, "Yesterday", "Last 7 days"),
    },
    plainSection(account, "Each account, yesterday"),
    plainSection(question, "One question"),
    plainSection(corrections, "Corrections"),
    plainSection(DEFINITIONS.slice(1), "Definitions"),
    { text: discrepancyText(), html: discrepancyHtml() },
  ];

  const text = sections.map((s) => s.text.join("\n")).join("\n\n");
  const prose = [...stamp, ...monthLines, ...opening, ...account, ...question, ...corrections];
  const proseWords = countWords(prose);
  const refused = refusals(text, table);
  if (proseWords > DAILY_WORD_CEILING) {
    refused.push(`prose runs to ${proseWords} words, over the ${DAILY_WORD_CEILING}-word ceiling`);
  }
  return { kind: "daily", periodKey: day, subject, text, html: assemble(sections), proseWords, refusals: refused };
}

// ── WEEKLY ──────────────────────────────────────────────────────────────────

const adsLink = (acct: string, ad: string) =>
  `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${acct}&selected_ad_ids=${ad}`;

export async function composeAgencyWeekly(monday: string, asOf = new Date()): Promise<ComposedAgency> {
  const sunday = shift(monday, 6);
  const a30 = shift(sunday, -29);
  const monthStart = `${sunday.slice(0, 7)}-01`;
  const [wRows, mRows, ledger] = await Promise.all([
    chain(monday, sunday),
    chain(monthStart, sunday),
    ledgerState(asOf),
  ]);
  const w = total(wRows);
  const wMeta = metaTotal(wRows);
  const final = moneyFinal(sunday, ledger);
  const suppress = ledger.stale;
  const adsAllowed = a30 >= AD_DATA_FLOOR;
  const adRows = adsAllowed ? await ads(a30, sunday) : [];

  const sections: Section[] = [];
  sections.push(
    plainSection([
      "Sabhi Digital — Meta accounts 1249430309131428 and 1109475161619539, plus Google Ads (paused).",
      `Week covered: Monday ${pretty(monday)} to Sunday ${pretty(sunday)}. ${
        suppress
          ? "Money is not shown: our accounts sheet has not been read for over 48 hours."
          : final
            ? "Every figure is final."
            : "Money is still being posted, so money figures can only rise."
      }`,
    ]),
  );

  const wRet = wMeta.spend > 0 ? wMeta.cash / GST / wMeta.spend : null;
  const label = adLabeller(adRows);
  sections.push(
    plainSection(
      [
        `Spend ${inr(w.spend)}, ${inr(w.spend / 7)} a day (Meta Ads) — target ${inr(TARGET_SPEND_DAY)} a day.`,
        suppress
          ? "Return: not shown until the accounts sheet is read again."
          : `Return ${wRet === null ? "no spend" : final ? x2(wRet) : `${x2(wRet)} or more`} (Meta only; accounts sheet, GST removed) — target ${x2(TARGET_RETURN_LOW)} to ${x2(TARGET_RETURN_HIGH)}. ${int(w.buyers)} women paid in all, ${cashText(w.cash, final)} collected:`,
        ...(suppress ? [] : buyerLines(wRows, final)),
        `${int(w.regs)} registered (our records) · ${int(w.attended)} turned up (Zoom) · ${int(w.atPrice)} still there when the price came (Zoom) · ${per100(w.regs, w.pageViews)} registered per 100 page views (our records ÷ Meta Ads).`,
      ],
      "Where the week landed",
    ),
  );

  // Return by advertisement, rolling 30 days.
  const retHead = `Return by advertisement — ${pretty(a30)} to ${pretty(sunday)}`;
  if (!adsAllowed) {
    sections.push(plainSection(["Not shown: this window reaches before 1 July 2026, when advertisement-level records begin."], retHead));
  } else if (suppress) {
    sections.push(plainSection(["Not shown: our accounts sheet has not been read for over 48 hours."], retHead));
  } else {
    const list = [...adRows].sort((a, b) => b.spend - a.spend);
    const judged = list.filter((r) => r.buyers >= MIN_SALES_VERDICT);
    const clear = judged.filter((r) => (r.cash ?? 0) / GST / r.spend >= TARGET_RETURN_LOW);
    const intro = `Target ${x2(TARGET_RETURN_LOW)}. ${clear.length} of ${judged.length} advertisements with ${MIN_SALES_VERDICT} or more sales clear it; ${list.length - judged.length} more have too few sales to judge. Sources: spend from Meta Ads, sales and cash from our accounts sheet, GST removed. About a fifth of buyers pay more than seven days after registering, which is why this uses 30 days.`;
    const shown = list.slice(0, 25);
    const textRows = shown.map((r) => {
      const ret = (r.cash ?? 0) / GST / r.spend;
      const tag = r.buyers < MIN_SALES_VERDICT ? " (too thin to judge)" : "";
      return `  ${label(r).slice(0, 44).padEnd(46)}${inr(r.spend).padEnd(12)}${String(r.buyers).padEnd(7)}${inr(r.cash ?? 0).padEnd(12)}${x2(ret).padEnd(8)}${r.buyers > 0 ? inr(r.spend / r.buyers) : "no sales"}${tag}`;
    });
    const more = list.length > shown.length ? [`  …and ${list.length - shown.length} smaller advertisements.`] : [];
    const th = "padding:4px 6px;text-align:right;white-space:nowrap;color:#666666";
    const td = "padding:4px 6px;text-align:right;white-space:nowrap";
    sections.push({
      text: [
        retHead.toUpperCase(),
        intro,
        `  ${"Advertisement".padEnd(46)}${"Spend".padEnd(12)}${"Sales".padEnd(7)}${"Cash".padEnd(12)}${"Return".padEnd(8)}Cost per sale`,
        ...textRows,
        ...more,
      ],
      html:
        headingHtml(retHead) +
        `<div>${esc(intro)}</div>` +
        `<table role="presentation" style="border-collapse:collapse;font-size:13px;width:100%;margin-top:8px"><tr><th style="padding:4px 6px;text-align:left;color:#666666">Advertisement</th><th style="${th}">Spend</th><th style="${th}">Sales</th><th style="${th}">Cash</th><th style="${th}">Return</th><th style="${th}">Cost per sale</th></tr>` +
        shown
          .map((r) => {
            const ret = (r.cash ?? 0) / GST / r.spend;
            const thin = r.buyers < MIN_SALES_VERDICT;
            return `<tr style="border-top:1px solid #eeeeee"><td style="padding:4px 6px">${esc(label(r))}</td><td style="${td}">${inr(r.spend)}</td><td style="${td}">${r.buyers}</td><td style="${td}">${inr(r.cash ?? 0)}</td><td style="${td}"><strong>${x2(ret)}</strong>${thin ? '<div style="font-size:11px;color:#666666">too thin to judge</div>' : ""}</td><td style="${td}">${r.buyers > 0 ? inr(r.spend / r.buyers) : "no sales"}</td></tr>`;
          })
          .join("") +
        `</table>` +
        (more.length ? `<div style="color:#666666">${esc((more[0] ?? "").trim())}</div>` : ""),
    });
  }

  sections.push(
    plainSection(
      [
        "Not measured yet. Most of these advertisements cannot yet be tied to the script or angle they carry, so no angle can be judged fairly. The creative asset key on your reporting (item below) would let us produce this.",
      ],
      "Angle summary",
    ),
  );

  // Page section.
  const pageHead = `Registrations per 100 women who reached the page — ${pretty(a30)} to ${pretty(sunday)}`;
  if (!adsAllowed) {
    sections.push(plainSection(["Not shown: this window reaches before 1 July 2026."], pageHead));
  } else {
    const rows = adRows
      .filter((r) => r.page_views >= MIN_BASE_PCT)
      .map((r) => ({ ...r, rate: (r.registrations / r.page_views) * 100 }))
      .sort((a, b) => b.rate - a.rate);
    const top = [...adRows].sort((a, b) => b.spend - a.spend)[0];
    const lines = [
      `Registrations from our records, page visits from Meta Ads. Only advertisements with ${MIN_BASE_PCT} or more page visits are listed (${rows.length}).`,
      ...rows.slice(0, 20).map(
        (r) =>
          `  ${Math.round(r.rate)} in 100 — ${label(r)} (${int(r.registrations)} of ${int(r.page_views)} page visits, ${inr(r.spend)} spent)${top && r.ad_id === top.ad_id ? " — your biggest spender" : ""}`,
      ),
    ];
    if (rows.length > 20) lines.push(`  …and ${rows.length - 20} more.`);
    sections.push(plainSection(lines, pageHead));
  }

  // How to open each advertisement.
  if (adsAllowed) {
    const list = [...adRows].sort((a, b) => b.spend - a.spend).slice(0, 15);
    sections.push({
      text: [
        "HOW TO OPEN EACH ADVERTISEMENT",
        "Each link opens the advertisement in your own Ads Manager (largest spend first):",
        ...list.map((r) => `  ${label(r)}: ${adsLink(r.account_id, r.ad_id)}`),
      ],
      html:
        headingHtml("How to open each advertisement") +
        `<div>Each link opens the advertisement in your own Ads Manager (largest spend first):</div>` +
        list
          .map(
            (r) =>
              `<div style="margin-left:12px"><a href="${esc(adsLink(r.account_id, r.ad_id))}" style="color:#1155cc">${esc(label(r))}</a></div>`,
          )
          .join(""),
    });
  }

  sections.push(plainSection(accountBlock(wRows, mRows, "this week", final, suppress), "Each account, this week"));

  const items = await openItems();
  // The long-tail question is asked as this week's question, not repeated here.
  const missingItems = items.filter((it) => !/under ten registrations|fewer than 10 registrations/i.test(it.body));
  sections.push(
    plainSection(
      missingItems.length === 0
        ? ["Nothing outstanding."]
        : missingItems.map((it, i) => `${i + 1}. ${it.body} (first raised ${pretty(it.raised_on)})`),
      "What we are still missing from you",
    ),
  );
  sections.push(
    plainSection(
      [longTailQuestion(adRows, a30, sunday)],
      "Question for this week",
    ),
  );
  sections.push(plainSection(DEFINITIONS.slice(1), "Definitions"));
  sections.push({ text: discrepancyText(), html: discrepancyHtml() });

  const text = sections.map((s) => s.text.join("\n")).join("\n\n");
  const subject = `Sabhi weekly — ${pretty(monday)} to ${pretty(sunday)} · ${inr(w.spend)} spent${
    !suppress && wRet !== null ? ` · return ${final ? x2(wRet) : `${x2(wRet)}+`}` : ""
  }`;
  return { kind: "weekly", periodKey: monday, subject, text, html: assemble(sections), refusals: refusals(text, null) };
}

// ── Sending ─────────────────────────────────────────────────────────────────

export async function sendAgencyEmail(composed: ComposedAgency): Promise<{
  status: "sent" | "already_sent" | "refused" | "no_key" | "failed";
  messageId: string | null;
  error: string | null;
}> {
  const pg = getPg();
  if (!pg) throw new Error("backend not configured");
  const existing = await pgSelect<{ status: string }[]>(
    pg,
    `/agency_email_log?select=status&kind=eq.${composed.kind}&period_key=eq.${composed.periodKey}`,
  ).catch(() => []);
  if (existing?.[0]?.status === "sent") return { status: "already_sent", messageId: null, error: null };

  const write = (patch: Record<string, unknown>) =>
    pgUpsert(
      pg,
      "agency_email_log",
      {
        kind: composed.kind,
        period_key: composed.periodKey,
        subject: composed.subject,
        body_text: composed.text,
        recipients: [...AGENCY_TO, ...OWNER_CC],
        refusals: composed.refusals,
        updated_at: new Date().toISOString(),
        ...patch,
      },
      "kind,period_key",
    ).catch(() => undefined);

  if (composed.refusals.length > 0) {
    const error = `Refused to send: ${composed.refusals.join("; ")}`;
    await write({ status: "refused", last_error: error });
    return { status: "refused", messageId: null, error };
  }
  const { mailKeyPresent, sendMail } = await import("./resend.server");
  if (!mailKeyPresent()) {
    await write({ status: "no_key", last_error: "The email connection is not in place." });
    return { status: "no_key", messageId: null, error: "The email connection is not in place." };
  }
  try {
    const { id } = await sendMail({
      to: AGENCY_TO,
      cc: OWNER_CC,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
    });
    await write({ status: "sent", message_id: id, sent_at: new Date().toISOString(), last_error: null });
    return { status: "sent", messageId: id, error: null };
  } catch (e) {
    await write({ status: "failed", last_error: safeMessage(e).slice(0, 500) });
    return { status: "failed", messageId: null, error: safeMessage(e) };
  }
}

/** Monday of the week that ended on the most recent Sunday (India time). */
export function lastClosedMonday(now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const dow = ist.getUTCDay(); // 0 = Sunday
  const back = dow === 0 ? 13 : dow + 6;
  ist.setUTCDate(ist.getUTCDate() - back);
  return ist.toISOString().slice(0, 10);
}

/**
 * The weekly question: something only the agency can answer from its own
 * screen, with money attached. Never a repeat of the missing list.
 */
function longTailQuestion(rows: AdRow[], from: string, to: string): string {
  const tail = rows.filter((r) => r.spend > 0 && r.registrations < 10);
  if (tail.length === 0) return "Nothing to ask this week beyond the list above.";
  const spend = tail.reduce((a, r) => a + r.spend, 0);
  return `From ${pretty(from)} to ${pretty(to)}, ${int(tail.length)} advertisements took ${inr(spend)} between them while each produced fewer than 10 registrations (Meta Ads spend; our registration records). Is that a deliberate testing budget — and if so, what has it taught you that is now running in the bigger advertisements?`;
}
