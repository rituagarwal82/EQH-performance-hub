/**
 * WHERE YESTERDAY'S SALES CAME FROM.
 *
 * Read from the collections ledger across every receipt source (course
 * platform and money paid straight to IDLS), one line per BUYER — a buyer
 * typed twice as a new sale on one day counts once, with her cash totalled.
 * Source is the channel of her first registration (first-touch, stored).
 */

import { emphSafe, headingHtml, inr, int, type Section } from "./email-blocks.server";
import { getPg, pgInsert, pgRpc, pgSelect } from "./pg.server";

export type BuyerRow = {
  email_key: string;
  payer_name: string;
  rows_count: number;
  cash: number;
  channel: string | null;
  source: string | null;
  paid_direct: boolean;
  first_reg: string | null;
  has_lead: boolean;
};

export async function fetchSaleSources(day: string): Promise<BuyerRow[] | null> {
  const pg = getPg();
  if (!pg) return null;
  try {
    return (await pgRpc<BuyerRow[]>(pg, "daily_sale_sources", { p_date: day })) ?? [];
  } catch {
    return null;
  }
}

/** The owner's own channel names, as the Agencies screen shows them. */
function label(r: BuyerRow): string {
  if (!r.has_lead) return "No lead record";
  const ch = r.channel ?? "";
  const src = r.source ?? "";
  if (!ch || ch === "No source recorded") return "No source recorded";
  if (ch === "Collaboration") return src.replace(/^Collaboration:\s*/, "") || "Collaboration";
  if (ch === "Influencer podcast") return src || ch;
  const m = ch.match(/^(.*?)\s*[–-]\s*(Meta|Google)/i);
  if (m) return `${m[1]} - ${m[2]![0]!.toUpperCase()}${m[2]!.slice(1).toLowerCase()}`;
  return ch;
}

type Band = "within 2 days" | "within 7 days" | "before that";
function band(day: string, first: string | null): Band | null {
  if (!first) return null;
  const d = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86400000;
  if (d <= 2) return "within 2 days";
  if (d <= 7) return "within 7 days";
  return "before that";
}

const sales = (n: number) => `${int(n)} ${n === 1 ? "sale" : "sales"}`;

export function saleSourcesSection(day: string, rows: BuyerRow[] | null): Section {
  const title = "WHERE YESTERDAY'S SALES CAME FROM";
  if (rows === null) {
    const t = `${title} — not available: the accounts sheet could not be read for this day.`;
    return { text: [t], html: `${headingHtml("Where yesterday's sales came from")}<div>Not available: the accounts sheet could not be read for this day.</div>` };
  }
  if (rows.length === 0) {
    const t = `${title} — no Silver sales are posted in the accounts sheet for this day.`;
    return { text: [t], html: `${headingHtml("Where yesterday's sales came from")}<div>No Silver sales are posted in the accounts sheet for this day.</div>` };
  }
  const total = rows.reduce((a, r) => a + Number(r.cash), 0);
  const groups = new Map<string, BuyerRow[]>();
  for (const r of rows) {
    const k = label(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const counts: Record<Band, number> = { "within 2 days": 0, "within 7 days": 0, "before that": 0 };
  const lineRows: { name: string; n: number; note: string }[] = [];
  for (const [name, rs] of ordered) {
    const c: Record<Band, number> = { "within 2 days": 0, "within 7 days": 0, "before that": 0 };
    let noLead = 0;
    for (const r of rs) {
      const b = band(day, r.first_reg);
      if (b) {
        c[b]++;
        counts[b]++;
      } else noLead++;
    }
    const parts: string[] = [];
    const only = (b: Band) => c[b] === rs.length;
    if (noLead === rs.length) parts.push("bought without registering");
    else if (only("before that")) parts.push("older");
    else {
      if (c["within 2 days"]) parts.push(`${c["within 2 days"]} joined within 2 days`);
      if (c["within 7 days"]) parts.push(`${c["within 7 days"]} within 7 days`);
      if (c["before that"]) parts.push(`${c["before that"]} older`);
      if (noLead) parts.push(`${noLead} bought without registering`);
    }
    lineRows.push({ name, n: rs.length, note: parts.join(", ") });
  }
  const direct = rows.filter((r) => r.paid_direct).length;
  const platform = rows.length - direct;
  const noLeadTotal = rows.filter((r) => !r.first_reg).length;
  const fresh = `HOW FRESH  within 2 days ${counts["within 2 days"]} · within 7 days ${counts["within 7 days"]} · before that ${counts["before that"]}${noLeadTotal ? ` · no registration ${noLeadTotal}` : ""}`;
  const paid = `PAID       ${platform} through the course platform · ${direct} by G-Pay or transfer direct`;
  const head = `${title} — ${sales(rows.length)}, ${inr(total)}`;
  const w = Math.max(...lineRows.map((l) => l.name.length)) + 2;
  const text = [
    head,
    ...lineRows.map((l) => `  ${l.name.padEnd(w)}${String(l.n).padEnd(5)}${l.note}`),
    `  ${fresh}`,
    `  ${paid}`,
  ];
  const td = "padding:2px 10px 2px 0;vertical-align:top";
  const html =
    headingHtml("Where yesterday's sales came from") +
    `<div style="margin-bottom:6px">${emphSafe(`${sales(rows.length)}, ${inr(total)}`)}</div>` +
    `<table style="border-collapse:collapse;font-size:14px">` +
    lineRows
      .map((l) => `<tr><td style="${td}">${emphSafe(l.name)}</td><td style="${td};text-align:right;font-weight:700">${l.n}</td><td style="${td};color:#555555">${emphSafe(l.note)}</td></tr>`)
      .join("") +
    `</table>` +
    `<div style="margin-top:6px;font-size:13px">${emphSafe(fresh.replace(/\s{2,}/g, " "))}</div>` +
    `<div style="font-size:13px">${emphSafe(paid.replace(/\s{2,}/g, " "))}</div>`;
  return { text, html };
}

type AmountGroup = {
  email_key: string;
  payer_name: string;
  amount: number;
  sheet_rows: number;
  platform_payments: number;
  counted: number;
  platform_dates: string[];
};

/**
 * Same buyer, same day, SAME amount typed more than once, beyond what the
 * course platform shows was paid: an accounts duplicate. Counted once; one
 * review item. Different amounts are genuine extra payments — no item.
 */
export async function raiseDuplicateBuyerItems(day: string, rows: BuyerRow[] | null) {
  const pg = getPg();
  if (!pg || !rows) return;
  const groups = await pgRpc<AmountGroup[]>(pg, "daily_sale_amount_groups", { p_date: day }).catch(() => null);
  if (!groups) return;
  for (const g of groups.filter((x) => x.sheet_rows > x.counted)) {
    const ref = `${day}:${g.email_key}:${Number(g.amount)}`;
    const open = await pgSelect<{ id: string }[]>(
      pg,
      `/review_items?select=id&kind=eq.duplicate_new_sale&ref_id=eq.${encodeURIComponent(ref)}`,
    ).catch(() => [{ id: "skip" }]);
    if (open.length > 0) continue;
    const amt = inr(Number(g.amount));
    const extra = g.sheet_rows - g.counted;
    const platformNote =
      g.platform_payments > 0
        ? ` The course platform holds ${g.platform_payments === 1 ? "one payment" : `${g.platform_payments} payments`} of ${amt} from her.`
        : " No course-platform payment was found to check against, so the repeat is treated as one payment.";
    const drift = (g.platform_dates ?? []).filter((d) => d !== day);
    const driftNote = drift.length
      ? ` Her payment is dated ${drift.join(", ")} by the course platform and ${day} by the accounts sheet — this one-day difference is why the reconciliation can show her as missing when she is not. The accounts sheet stays the record, so she counts on ${day}.`
      : "";
    await pgInsert(pg, "review_items", {
      kind: "duplicate_new_sale",
      ref_id: ref,
      title: `${g.payer_name} is typed ${g.sheet_rows} times as a new sale of ${amt} on ${day}`,
      detail: `The accounts sheet has ${g.sheet_rows} identical "New Sale" rows of ${amt} for ${g.payer_name} on ${day}.${platformNote} The engine counts ${g.counted === 1 ? "one payment" : `${g.counted} payments`}, so ${extra === 1 ? "one row is" : `${extra} rows are`} left out of the cash. Please ask the accounts team to remove the duplicate row.${driftNote}`,
      evidence: { email_key: g.email_key, business_date: day, amount: g.amount, sheet_rows: g.sheet_rows, platform_payments: g.platform_payments, counted: g.counted, platform_dates: g.platform_dates },
    }).catch(() => undefined);
  }
}

/**
 * Whether the 5 p.m. read of the accounts sheet happened today and brought
 * anything new. Returns the sentence the email prints.
 */
export async function eveningReadLine(): Promise<{ settled: boolean; line: string }> {
  const pg = getPg();
  if (!pg) return { settled: false, line: "The accounts sheet's 5 p.m. read could not be checked, so yesterday's sales below may not be final." };
  const now = new Date();
  const todayUtc = now.toISOString().slice(0, 10);
  const since = `${todayUtc}T11:25:00Z`;
  try {
    const runs = await pgSelect<{ started_at: string; status: string; rows_written: number }[]>(
      pg,
      `/sync_runs?select=started_at,status,rows_written&source=eq.ledger&order=started_at.desc&limit=5`,
    );
    const evening = runs.find((r) => r.started_at >= since);
    if (now.toISOString() < since) {
      return { settled: false, line: "Counted from the accounts sheet before today's 5 p.m. read, so yesterday's sales below may not be final." };
    }
    if (!evening) {
      return { settled: false, line: "The accounts sheet's 5 p.m. read did not run today, so yesterday's sales below may not be final." };
    }
    if (evening.status !== "ok") {
      return { settled: false, line: "The accounts sheet's 5 p.m. read failed today, so yesterday's sales below may not be final." };
    }
    const prev = runs.find((r) => r.started_at < evening.started_at && r.status === "ok");
    if (prev && Number(prev.rows_written) === Number(evening.rows_written)) {
      return { settled: false, line: "Counted from the accounts sheet as it stood at 5 p.m. — but that read brought nothing new since the morning, so yesterday may not be fully posted yet." };
    }
    return { settled: true, line: "Counted from the accounts sheet as it stood at 5 p.m." };
  } catch {
    return { settled: false, line: "The accounts sheet's 5 p.m. read could not be checked, so yesterday's sales below may not be final." };
  }
}
