/**
 * THE PIECES BOTH EMAILS ARE BUILT FROM.
 *
 * Every figure here is read from the same stored tables the screens read, so
 * an email can never quietly disagree with the app. Where a figure is not in
 * yet it is named as missing — a zero is never printed in its place.
 */

import { getPg, pgRpc } from "./pg.server";

export const inr = (n: number) =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(n))}`;

export const int = (n: number) => new Intl.NumberFormat("en-IN").format(Math.round(n));

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type Section = { text: string[]; html: string };

/** Where the app lives, for links and for serving our own thumbnails. */
export const appUrl = () =>
  process.env["EMAIL_APP_URL"] ??
  "https://id-preview--99936e18-5a56-46c8-ac3a-3a284371d25c.lovable.app";

/**
 * The ad's picture, served from our own address.
 *
 * The stored Meta address is signed and expires within days, so the picture is
 * asked for by ad, and our own door fetches a fresh address at the moment the
 * email is opened. The stored one is passed along only as a last resort.
 */
export const proxiedImage = (adId: string, url: string | null, w = 96) =>
  `${appUrl()}/api/public/img?w=${w}&ad=${encodeURIComponent(adId)}${
    url ? `&u=${encodeURIComponent(url)}` : ""
  }`;

/** A section heading: small caps with a thin rule above it. */
export const headingHtml = (t: string) =>
  `<div style="border-top:1px solid #dddddd;margin:18px 0 8px;padding-top:10px;font-size:12px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:#666666">${esc(t)}</div>`;

/** Numbers carry the meaning, so they are the bold part of every sentence. */
export const emphSafe = (plain: string) => emph(esc(plain));

const emph = (escaped: string) =>
  escaped.replace(/(₹[\d,]+|\b\d[\d,]*(?:\.\d+)?%?\b)/g, "<strong>$1</strong>");

const isHeading = (l: string) => /^[A-Z][A-Z0-9 ₹—\-(),.·%]+$/.test(l.trim()) && l.trim().length > 3;

const para = (lines: string[]) =>
  lines
    .map((l) => {
      if (l.trim() === "") return '<div style="height:10px"></div>';
      if (isHeading(l)) return headingHtml(l.trim());
      const body = emph(esc(l));
      return l.startsWith("  ")
        ? `<div style="margin-left:12px">${body}</div>`
        : `<div>${body}</div>`;
    })
    .join("");

export const sectionFromLines = (lines: string[]): Section => ({ text: lines, html: para(lines) });

// ── Who each source is called in plain English ───────────────────────────────

const SOURCE_BUCKETS: { label: string; channels: string[]; spendCode: string | null; note: string | null }[] = [
  { label: "Sabhi Meta", channels: ["Sabhi Digital – Meta ads"], spendCode: "SD", note: null },
  {
    label: "Sabhi Google",
    channels: ["Sabhi Digital – Google Ads"],
    spendCode: null,
    note: "spend not connected",
  },
  { label: "Rajdeep", channels: ["Rajdeep (in-house) – Meta ads"], spendCode: "RJ", note: null },
  { label: "Parami", channels: ["Parami – Meta ads"], spendCode: "PRM", note: null },
  { label: "Podcasts", channels: [], spendCode: null, note: "no ad spend" },
  { label: "Own channels", channels: [], spendCode: null, note: "no ad spend" },
  { label: "Not yet identified", channels: [], spendCode: null, note: "no ad spend" },
];

function bucketFor(channel: string): string {
  for (const b of SOURCE_BUCKETS) if (b.channels.includes(channel)) return b.label;
  if (/podcast/i.test(channel)) return "Podcasts";
  if (/^(Own funnel|Organic \/ own|Organic search|Talks & offline events)$/.test(channel)) {
    return "Own channels";
  }
  return "Not yet identified";
}

export const AGENCY_NAMES: Record<string, string> = {
  SD: "Sabhi Digital",
  RJ: "Rajdeep (in-house)",
  PRM: "Parami",
  SX: "ScaleX (closed)",
};

type MonthFigures = {
  start: string;
  prev_start: string;
  prev_end: string;
  sales: { slot: string; channel: string; sales: number; fully_paid: number; cash: number }[];
  registrations: { slot: string; channel: string; registrations: number }[];
  spend: { slot: string; agency_code: string; spend: number }[];
};

export type MonthBlock = {
  section: Section;
  totalSales: number;
  prevSales: number;
  liveUnjudged: { label: string; spend: number; registrations: number }[];
};

/** "This month so far", against exactly the same days of last month. */
export async function monthBlock(day: string): Promise<MonthBlock> {
  const pg = getPg();
  if (!pg) throw new Error("backend not configured");
  const m = await pgRpc<MonthFigures>(pg, "daily_email_month_figures", { p_date: day });

  const sales = new Map<string, { now: number; prev: number }>();
  const regs = new Map<string, { now: number; prev: number }>();
  for (const b of SOURCE_BUCKETS) {
    sales.set(b.label, { now: 0, prev: 0 });
    regs.set(b.label, { now: 0, prev: 0 });
  }
  for (const r of m?.sales ?? []) {
    const e = sales.get(bucketFor(r.channel))!;
    if (r.slot === "now") e.now += Number(r.sales ?? 0);
    else e.prev += Number(r.sales ?? 0);
  }
  for (const r of m?.registrations ?? []) {
    const e = regs.get(bucketFor(r.channel))!;
    if (r.slot === "now") e.now += Number(r.registrations ?? 0);
    else e.prev += Number(r.registrations ?? 0);
  }
  const spend = new Map<string, { now: number; prev: number }>();
  for (const r of m?.spend ?? []) {
    const e = spend.get(r.agency_code) ?? { now: 0, prev: 0 };
    if (r.slot === "now") e.now += Number(r.spend ?? 0);
    else e.prev += Number(r.spend ?? 0);
    spend.set(r.agency_code, e);
  }

  let totalSales = 0;
  let prevSales = 0;
  for (const v of sales.values()) {
    totalSales += v.now;
    prevSales += v.prev;
  }

  const diff = totalSales - prevSales;
  const versus =
    prevSales === 0
      ? "no comparison — last month had no sales over the same days"
      : diff === 0
        ? "exactly level with the same days of last month"
        : `${diff > 0 ? "ahead by" : "behind by"} ${Math.abs(diff)} against the same days of last month (${prevSales})`;

  const lines: string[] = [];
  lines.push("THIS MONTH SO FAR");
  lines.push(`- ${totalSales} Silver sales, ${versus}.`);

  const rows: { label: string; sales: number; cps: string; prevCps: string }[] = [];
  const liveUnjudged: MonthBlock["liveUnjudged"] = [];

  for (const b of SOURCE_BUCKETS) {
    const s = sales.get(b.label)!;
    const sp = b.spendCode ? spend.get(b.spendCode) : undefined;
    const cps =
      b.spendCode && sp
        ? s.now > 0
          ? inr(sp.now / s.now)
          : "no sales yet"
        : (b.note ?? "no ad spend");
    const prevCps =
      b.spendCode && sp && s.prev > 0 ? inr(sp.prev / s.prev) : b.spendCode ? "—" : "";
    rows.push({ label: b.label, sales: s.now, cps, prevCps });
    if (b.spendCode && sp && sp.now > 0 && s.now === 0) {
      liveUnjudged.push({ label: b.label, spend: sp.now, registrations: regs.get(b.label)!.now });
    }
  }

  for (const r of rows) {
    lines.push(
      `  ${r.label}: ${r.sales} sale${r.sales === 1 ? "" : "s"} · cost per sale — ${r.cps}${
        r.prevCps ? ` (last month ${r.prevCps})` : ""
      }`,
    );
  }

  const rightTh = `padding:4px 6px;text-align:right;white-space:nowrap`;
  const rightTd = `padding:5px 6px;text-align:right;white-space:nowrap`;
  const html =
    headingHtml("This month so far") +
    `<div>${emphSafe(`${totalSales} Silver sales, ${versus}.`)}</div>` +
    `<table role="presentation" style="border-collapse:collapse;margin-top:10px;font-size:14px;width:100%">` +
    `<tr style="color:#666666"><th style="padding:4px 6px;text-align:left">Source</th><th style="${rightTh}">Sales</th><th style="${rightTh}">Cost per sale</th><th style="${rightTh}">Last month</th></tr>` +
    rows
      .map(
        (r) =>
          `<tr style="border-top:1px solid #eeeeee"><td style="padding:5px 6px">${esc(r.label)}</td><td style="${rightTd}"><strong>${r.sales}</strong></td><td style="${rightTd};border-left:1px solid #f0f0f0"><strong>${esc(r.cps)}</strong></td><td style="${rightTd};color:#666666">${esc(r.prevCps || "—")}</td></tr>`,
      )
      .join("") +
    `</table>`;

  return { section: { text: lines, html }, totalSales, prevSales, liveUnjudged };
}

// ── Ads ──────────────────────────────────────────────────────────────────────

export type AdRow = {
  entity_id: string;
  ad_name: string | null;
  account_id: string | null;
  agency_code: string | null;
  thumbnail_url: string | null;
  permalink_url: string | null;
  spend: number;
  registrations: number;
  cost_per_reg: number | null;
  sales: number;
  cost_per_sale: number | null;
};

export const STOP_ABOVE = 12000;
export const SCALE_BELOW = 9000;
export const MIN_REGS_FOR_VERDICT = 30;

export function adsManagerLink(row: AdRow) {
  const act = (row.account_id ?? "").replace(/^act_/, "");
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${act}&selected_ad_ids=${row.entity_id}`;
}

/** The owner's own thresholds, and never a verdict on too little evidence. */
export function verdict(row: AdRow): string {
  if (row.registrations < MIN_REGS_FOR_VERDICT) return "Too early — fewer than 30 registrations.";
  if (row.sales === 0) return "Consider stopping — spending with no sales.";
  const cps = row.cost_per_sale ?? 0;
  if (cps > STOP_ABOVE) return "Consider stopping — above ₹12,000 a sale.";
  if (cps < SCALE_BELOW) return "Consider scaling — below ₹9,000 a sale.";
  return "Holding steady.";
}

export async function fetchAdRows(days = 14): Promise<AdRow[]> {
  const pg = getPg();
  if (!pg) throw new Error("backend not configured");
  const rows = await pgRpc<AdRow[]>(pg, "ad_performance", { p_days: days });
  return (rows ?? []).map((r) => ({
    ...r,
    spend: Number(r.spend ?? 0),
    registrations: Number(r.registrations ?? 0),
    cost_per_reg: r.cost_per_reg === null ? null : Number(r.cost_per_reg),
    sales: Number(r.sales ?? 0),
    cost_per_sale: r.cost_per_sale === null ? null : Number(r.cost_per_sale),
  }));
}

/** The whole email may never carry more than this many pictures. */
export const IMAGE_CAP = 8;

function moneyLine(r: AdRow): string {
  return `${inr(r.spend)} spent · ${int(r.registrations)} registrations · ${
    r.cost_per_reg === null ? "cost per registration not available" : `${inr(r.cost_per_reg)} each`
  } · ${r.sales} sale${r.sales === 1 ? "" : "s"} · ${
    r.cost_per_sale === null ? "no cost per sale yet" : `${inr(r.cost_per_sale)} a sale`
  }`;
}

/** The verdict is the only coloured text in the email. */
function verdictColour(v: string): string {
  if (v.startsWith("Consider scaling")) return "#137333";
  if (v.startsWith("Consider stopping")) return "#b3261e";
  if (v.startsWith("Too early")) return "#666666";
  return "#333333";
}

function adText(r: AdRow): string[] {
  const team = AGENCY_NAMES[r.agency_code ?? ""] ?? "team not recorded";
  const links = r.permalink_url
    ? `    Watch: ${r.permalink_url} | Ads Manager: ${adsManagerLink(r)}`
    : `    Ads Manager: ${adsManagerLink(r)}`;
  return [
    `  ${r.ad_name ?? r.entity_id} — ${team}`,
    `    ${moneyLine(r)}`,
    `    ${verdict(r)}`,
    links,
  ];
}

function adHtml(r: AdRow, withImage = false): string {
  const team = AGENCY_NAMES[r.agency_code ?? ""] ?? "team not recorded";
  const name = r.ad_name ?? r.entity_id;
  // A dead grey "not a public post" label helps nobody: when there is no public
  // link, the row simply carries Ads Manager.
  const links =
    (r.permalink_url
      ? `<a href="${esc(r.permalink_url)}" style="color:#1155cc">Watch</a> · `
      : "") +
    `<a href="${esc(adsManagerLink(r))}" style="color:#1155cc">Open in Ads Manager</a>`;
  const v = verdict(r);
  const pic =
    withImage && r.thumbnail_url
      ? `<div style="margin-bottom:8px"><img src="${esc(proxiedImage(r.entity_id, r.thumbnail_url, 96))}" width="96" height="96" alt="${esc(`Thumbnail for ${name}`)}" style="width:96px;height:96px;object-fit:cover;border-radius:4px;display:block;border:0"></div>`
      : "";
  return (
    `<div style="border:1px solid #eeeeee;border-radius:6px;padding:12px;margin:10px 0;font-size:14px">` +
    pic +
    `<div style="font-weight:700;font-size:15px">${esc(name)}</div>` +
    `<div style="color:#666666">${esc(team)}</div>` +
    `<div style="margin-top:6px">${emphSafe(moneyLine(r))}</div>` +
    `<div style="margin-top:6px;color:${verdictColour(v)}">${esc(v)}</div>` +
    `<div style="margin-top:6px">${links}</div>` +
    `</div>`
  );
}

/** Three best and three costliest ads of the last fortnight. */
export function adsSection(rows: AdRow[], days = 14, imageBudget = IMAGE_CAP): Section {
  const spending = rows.filter((r) => r.spend > 0);
  // Judged ads only, so a single sale off five registrations cannot look like
  // the best ad we run. If nothing has enough evidence yet, the block says so.
  const withSales = spending.filter((r) => r.sales > 0 && r.cost_per_sale !== null);
  const judgeable = withSales.filter((r) => r.registrations >= MIN_REGS_FOR_VERDICT);
  const pool = judgeable.length > 0 ? judgeable : withSales;
  const best = [...pool].sort((a, b) => (a.cost_per_sale ?? 0) - (b.cost_per_sale ?? 0)).slice(0, 3);
  const bestIds = new Set(best.map((r) => r.entity_id));
  const costly = spending
    .filter((r) => !bestIds.has(r.entity_id))
    .filter((r) => r.sales === 0 || (r.cost_per_sale ?? 0) > STOP_ABOVE)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 3);

  let budget = Math.max(0, Math.min(imageBudget, IMAGE_CAP));
  const takeImage = (r: AdRow) => {
    if (budget > 0 && r.thumbnail_url) {
      budget -= 1;
      return true;
    }
    return false;
  };

  const head = `ADS — LAST ${days} DAYS`;
  const text: string[] = [head];
  let html = headingHtml(head);

  if (spending.length === 0) {
    text.push("- No ad spend has arrived for this window yet.");
    html += `<div>No ad spend has arrived for this window yet.</div>`;
    return { text, html };
  }

  const bestHead =
    judgeable.length > 0
      ? "Best three (cheapest sales):"
      : "Best three (cheapest sales) — all still on too little evidence to judge:";
  text.push(bestHead);
  html += `<div style="margin-top:6px;color:#666666">${esc(bestHead)}</div>`;
  if (best.length === 0) {
    text.push("  No ad in this window has produced a sale yet.");
    html += `<div>No ad in this window has produced a sale yet.</div>`;
  }
  for (const r of best) {
    text.push(...adText(r));
    html += adHtml(r, takeImage(r));
  }

  text.push("Costliest three (most spend, no or few sales):");
  html += `<div style="margin-top:10px;color:#666666">Costliest three (most spend, no or few sales)</div>`;
  if (costly.length === 0) {
    text.push("  Nothing is spending without results.");
    html += `<div>Nothing is spending without results.</div>`;
  }
  for (const r of costly) {
    text.push(...adText(r));
    html += adHtml(r, takeImage(r));
  }

  return { text, html };
}

/** How many pictures this ad block will actually carry. */
export function adsSectionImageCount(rows: AdRow[], imageBudget = IMAGE_CAP): number {
  const s = adsSection(rows, 14, imageBudget);
  return (s.html.match(/<img /g) ?? []).length;
}

/** Every ad over a spend floor, ranked by cost per sale — the weekly view. */
export function adsTableSection(rows: AdRow[], floor: number, days: number): Section {
  const list = rows
    .filter((r) => r.spend >= floor)
    .sort((a, b) => (a.cost_per_sale ?? Number.MAX_SAFE_INTEGER) - (b.cost_per_sale ?? Number.MAX_SAFE_INTEGER));
  const head = `EVERY AD OVER ${inr(floor)} IN THE LAST ${days} DAYS (${list.length})`;
  const text: string[] = [head];
  let html = headingHtml(head);
  if (list.length === 0) {
    text.push("- No ad passed that spend in this window.");
    html += `<div>No ad passed that spend in this window.</div>`;
    return { text, html };
  }
  // The weekly list is long, so it carries no pictures at all.
  for (const r of list) {
    text.push(...adText(r));
    html += adHtml(r, false);
  }
  return { text, html };
}
