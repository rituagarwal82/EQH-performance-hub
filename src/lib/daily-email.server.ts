/**
 * THE DAILY STATUS EMAIL.
 *
 * The owner should not have to open a screen to learn that something stopped.
 * Once a day, after the collections, register, checks, signed-figure and
 * analyst jobs have run, this composes one short email in the same words the
 * app uses and sends it.
 *
 * Two rules decide everything here:
 *   - It tells the truth. "Everything arrived on time" is only ever written
 *     when the checks actually ran and passed; a figure that is not in yet is
 *     named as missing, never printed as a zero.
 *   - It is sent at most once per business day. The retry half an hour later
 *     calls the same door and does nothing if the morning send succeeded.
 */

import { computeOwnerTrust } from "./owner-trust.server";
import type { OwnerTrust } from "./owner-trust.functions";
import { mailKeyPresent, resolveSender, sendMail } from "./resend.server";
import {
  adsSection,
  emphSafe,
  esc,
  fetchAdRows,
  headingHtml,
  inr,
  int,
  monthBlock,
  sectionFromLines,
  type Section,
} from "./email-blocks.server";
import { getPg, pgRpc, pgSelect, pgUpsert } from "./pg.server";
import { safeMessage } from "./safe-error";

/** The address the owner actually reads, and the account address kept copied. */
export const PRIMARY = ["rituagarwal82@gmail.com"];
export const COPY = ["connect@energyqueenshub.com"];
const RECIPIENTS = [...PRIMARY, ...COPY];
const APP_URL = "https://id-preview--99936e18-5a56-46c8-ac3a-3a284371d25c.lovable.app";

type DayFigures = {
  date: string;
  spend: number | null;
  spend_available: boolean;
  registrations: number | null;
  sessions: number;
  attendees: number | null;
  zoom_registrants: number | null;
  show_up_pct: number | null;
  sales: number;
  fully_paid: number;
  cash: number;
  cash_new_sales: number;
  ledger_covers_day: boolean | null;
};

export type DailyEmailStatusRow = {
  business_date: string;
  status: string;
  subject: string | null;
  body_text: string | null;
  recipients: string[] | null;
  attempts: number;
  last_error: string | null;
  sent_at: string | null;
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The business day just finished, in Indian time (business day starts 06:00). */
export function yesterdayIst(now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}

function prettyDate(d: string) {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** "up 8%", "down 6%", "about the same", or nothing when there is no basis. */
function change(today: number | null, prev: number | null): string {
  if (today === null || prev === null || prev === 0) return "";
  const pct = Math.round(((today - prev) / prev) * 100);
  if (Math.abs(pct) < 3) return " (about the same as the day before)";
  return ` (${pct > 0 ? "up" : "down"} ${Math.abs(pct)}% on the day before)`;
}

export type ComposedEmail = {
  businessDate: string;
  subject: string;
  text: string;
  html: string;
  attentionCount: number;
  attentionKeys: string[];
  imageCount: number;
  htmlBytes: number;
};

/** Which screen answers each kind of attention item. */
function attentionHref(key: string): string {
  if (key.startsWith("check-") || key === "goldens") return `${APP_URL}/confidence`;
  if (key.startsWith("cred-")) return `${APP_URL}/health`;
  if (key.startsWith("daily-email")) return `${APP_URL}/settings`;
  return `${APP_URL}/health`;
}

/**
 * One block of the email. A slow or failed read NEVER stops the email: it is
 * tried twice, and if it still fails the email says that block could not be
 * read. (26 Sep: a single timed-out ads query killed the whole email, silently,
 * for a day — this is the guard against that whole category.)
 */
async function soft<T>(label: string, missing: string[], fn: () => Promise<T>, fallback: T): Promise<T> {
  for (let i = 0; i < 2; i += 1) {
    try {
      return await fn();
    } catch (e) {
      console.error(`[EQH] daily email block "${label}" failed (attempt ${i + 1}):`, e instanceof Error ? e.message : String(e));
      if (i === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  missing.push(label);
  return fallback;
}

export type ComposeOptions = { lateNote?: string | undefined };

export async function composeDailyEmail(
  businessDate?: string,
  trustOverride?: OwnerTrust,
  options: ComposeOptions = {},
): Promise<ComposedEmail> {
  const day = businessDate ?? yesterdayIst();
  const pg = getPg();
  if (!pg) throw new Error("backend not configured");

  const missing: string[] = [];
  const emptyTrust = { configured: false, checksRun: 0, error: "unreadable", attention: [], decisions: [] } as unknown as OwnerTrust;
  const [trust, figures, monthRaw, adRows, traced, ledgerLatest] = await Promise.all([
    trustOverride
      ? Promise.resolve(trustOverride)
      : soft("the daily checks", missing, () => computeOwnerTrust(), emptyTrust),
    soft(
      "yesterday's figures",
      missing,
      () => pgRpc<{ day?: DayFigures; prev?: DayFigures }>(pg, "daily_email_figures", { p_date: day }),
      null as { day?: DayFigures; prev?: DayFigures } | null,
    ),
    soft("the month so far", missing, () => monthBlock(day), null as Awaited<ReturnType<typeof monthBlock>> | null),
    soft("the ads", missing, () => fetchAdRows(14), null as Awaited<ReturnType<typeof fetchAdRows>> | null),
    soft(
      "tracking coverage",
      missing,
      () =>
        pgRpc<{ channel: string; registrations: number; traced: number; first_seen: string | null }[]>(
          pg,
          "channel_traced_registrations",
          { p_date: day },
        ),
      [] as { channel: string; registrations: number; traced: number; first_seen: string | null }[],
    ),
    pgSelect<{ business_date: string }[]>(
      pg,
      "/ledger_inflow?select=business_date&order=business_date.desc&limit=1",
    )
      .then((r) => r?.[0]?.business_date ?? null)
      .catch(() => null),
  ]);
  const month = monthRaw ?? {
    section: sectionFromLines(["THIS MONTH SO FAR: could not be read this evening."]),
    totalSales: NaN,
    prevSales: NaN,
    liveUnjudged: [],
  };
  const monthKnown = monthRaw !== null;

  const d = figures?.day;
  const p = figures?.prev;
  const sections: Section[] = [];
  const head: string[] = [];

  // (0) The one line that says how the month is going, at the very top and in
  // the inbox list beside the subject.
  const monthDiff = month.totalSales - month.prevSales;
  const headline = !monthKnown
    ? "This month's sales could not be read this evening"
    : month.prevSales === 0
      ? `${month.totalSales} Silver sales this month — no comparison with last month`
      : monthDiff === 0
        ? `${month.totalSales} Silver sales this month — exactly level with last month`
        : `${month.totalSales} Silver sales this month — ${Math.abs(monthDiff)} ${
            monthDiff > 0 ? "ahead of" : "behind"
          } last month`;
  sections.push({
    text: [headline],
    html: `<div style="font-size:20px;line-height:1.3;font-weight:700;color:#111111;margin-bottom:10px">${emphSafe(headline)}</div>`,
  });

  if (options.lateNote) sections.push(sectionFromLines([options.lateNote]));
  if (missing.length > 0) {
    sections.push(
      sectionFromLines([
        `Could not be read this evening: ${missing.join(", ")}. Everything else below is complete; those parts are missing, not zero.`,
      ]),
    );
  }
  // A day is SETTLED once the ledger holds a posting dated later than it.
  // Until then the email still goes out — it just says the money may grow.
  const provisional = ledgerLatest === null || ledgerLatest <= day;

  // (a) One line. "Everything arrived on time" is only allowed when the checks
  // really ran and really passed.
  const checksRan = trust.configured && trust.checksRun > 0 && !trust.error;
  const attention = trust.attention ?? [];
  if (!checksRan) {
    head.push(
      "The daily checks could not be read this morning, so nothing below can be called healthy.",
    );
  } else if (attention.length === 0) {
    head.push("Everything arrived on time and every number checks out.");
  } else {
    head.push(
      attention.length === 1 ? "One thing needs attention." : `${attention.length} things need attention.`,
    );
  }
  sections.push(sectionFromLines(head));

  // (1) What needs attention: what is wrong, what it costs, who must act.
  // Every line links straight to the screen that shows it.
  if (attention.length > 0) {
    const lines = ["NEEDS ATTENTION"];
    let html = headingHtml("Needs attention");
    for (const a of attention) {
      const href = attentionHref(a.key);
      lines.push(`- ${a.text}`);
      lines.push(`  Open: ${href}`);
      html += `<div style="margin-bottom:8px">${emphSafe(a.text)} <a href="${esc(href)}" style="color:#1155cc">Open the screen</a></div>`;
    }
    sections.push({ text: lines, html });
  }

  // (2) Yesterday in numbers, with a plain comparison.
  const y: string[] = [`YESTERDAY (${prettyDate(day).toUpperCase()})`];

  const spend = num(d?.spend);
  if (d?.spend_available && spend !== null) {
    y.push(`- Ad spend ${inr(spend)}${change(spend, num(p?.spend))}`);
  } else {
    y.push("- Ad spend: not in yet — yesterday's spend has not arrived from Meta.");
  }

  const regs = num(d?.registrations);
  if (regs !== null) {
    y.push(`- Registrations ${int(regs)}${change(regs, num(p?.registrations))}`);
  } else {
    y.push("- Registrations: not in yet — yesterday's lead counts have not arrived from Meta.");
  }

  const att = num(d?.attendees);
  const expected = num(d?.zoom_registrants);
  const show = num(d?.show_up_pct);
  if (att !== null && expected !== null && show !== null) {
    y.push(
      `- Attended ${int(att)} of the ${int(expected)} expected, ${show}%${change(show, num(p?.show_up_pct))}`,
    );
  } else if ((d?.sessions ?? 0) === 0) {
    y.push("- Attended: no webinar ran yesterday.");
  } else {
    y.push("- Attended: not available — attendance for yesterday's session has not arrived.");
  }

  // Sales count DISTINCT BUYERS from the collections ledger, across every
  // receipt source — money paid straight to IDLS never touches TagMango.
  const { fetchSaleSources, saleSourcesSection, eveningReadLine } = await import(
    "./sale-sources.server"
  );
  const prevDay = new Date(`${day}T00:00:00Z`);
  prevDay.setUTCDate(prevDay.getUTCDate() - 1);
  const [buyers, prevBuyers, evening] = await Promise.all([
    soft("yesterday's sales", missing, () => fetchSaleSources(day), null as Awaited<ReturnType<typeof fetchSaleSources>> | null),
    soft("the day before's sales", missing, () => fetchSaleSources(prevDay.toISOString().slice(0, 10)), null as Awaited<ReturnType<typeof fetchSaleSources>> | null),
    soft("the evening ledger read", missing, () => eveningReadLine(), { line: "The evening ledger read could not be checked." } as Awaited<ReturnType<typeof eveningReadLine>>),
  ]);
  if (d?.ledger_covers_day && buyers) {
    const n = buyers.length;
    const cash = buyers.reduce((a, r) => a + Number(r.cash), 0);
    const pn = prevBuyers ? prevBuyers.length : null;
    const pc = prevBuyers ? prevBuyers.reduce((a, r) => a + Number(r.cash), 0) : null;
    y.push(`- Silver sales ${int(n)} (buyers, each counted once)${change(n, pn)}`);
    y.push(`- Silver cash ${inr(cash)}${change(cash, pc)}`);
    y.push(`  ${evening.line}`);
  } else {
    y.push(
      "- Sales and cash: not available — the accounts ledger has not been updated to yesterday.",
    );
    y.push(`  ${evening.line}`);
  }
  if (d?.ledger_covers_day && provisional) {
    y.push(
      "  Provisional: the accounts ledger has nothing dated after this day yet, so late postings may still add to these sales and cash.",
    );
  }
  sections.push(sectionFromLines(y));
  if (d?.ledger_covers_day && buyers) sections.push(saleSourcesSection(day, buyers));

  // (3) The month so far, by source.
  sections.push(month.section);

  // (4) The ads themselves.
  sections.push(
    adRows ? adsSection(adRows, 14) : sectionFromLines(["THE ADS: could not be read this evening."]),
  );

  // (5) Money going out whose results cannot be read yet.
  if (month.liveUnjudged.length > 0) {
    const lines = ["LIVE BUT NOT YET JUDGEABLE"];
    for (const u of month.liveUnjudged) {
      const t = (traced ?? []).find((r) => r.channel.startsWith(u.label));
      const since = t?.first_seen ? `live since ${prettyDate(t.first_seen)}, ` : "";
      const tracking =
        t && Number(t.traced ?? 0) === 0
          ? " Tracking parameters are still missing, so no sale can be traced back to their ads."
          : "";
      lines.push(
        `- ${u.label}: ${since}${inr(u.spend)} spent, ${int(u.registrations)} registrations, no sales yet.${tracking}`,
      );
    }
    sections.push(sectionFromLines(lines));
  }

  // (6) Decisions waiting.
  const decisions = trust.decisions ?? [];
  sections.push(
    sectionFromLines(
      decisions.length === 0
        ? ["WAITING FOR YOU: nothing today."]
        : [
            `WAITING FOR YOU: ${decisions.length} decision${decisions.length === 1 ? "" : "s"}.`,
            `Top one — ${decisions[0]!.title} ${decisions[0]!.sentence}`,
          ],
    ),
  );

  // (6b) The price actually charged. Without this, a discounted month reads as
  // a fall in performance.
  const priceLines = await priceMixLines(day).catch(() => [] as string[]);
  if (priceLines.length > 0) sections.push(sectionFromLines(priceLines));

  // (7) What the cash line means, how old the sources are, and the way in.
  sections.push(
    sectionFromLines([
      "Silver cash means payments received that day against sales tagged new that day for the first course — the same figure the Sales screen shows.",
      await sourceAgeLine().catch(() => "Source ages could not be read for this email."),
      `Open the engine: ${APP_URL}`,
    ]),
  );

  const attentionPart = !checksRan
    ? "checks could not be read"
    : attention.length === 0
      ? "all clear"
      : `${attention.length} need attention`;
  const subject = `EQH daily — ${prettyDate(day)} · ${monthKnown ? `${month.totalSales} Silver sales this month` : "month not readable"} · ${attentionPart}`;

  const html = wrapHtml(sections, headline);
  return {
    businessDate: day,
    subject,
    text: sections.map((s) => s.text.join("\n")).join("\n\n"),
    html,
    attentionCount: attention.length,
    attentionKeys: attention.map((a) => a.key),
    imageCount: (html.match(/<img /g) ?? []).length,
    htmlBytes: new TextEncoder().encode(html).length,
  };
}

/**
 * No figure about a recent day goes out undated. The accounts sheet is typed
 * up by hand and lags; TagMango is read hourly. Saying so is cheaper than
 * being quietly wrong.
 */
async function sourceAgeLine(): Promise<string> {
  const { getPg, pgSelect } = await import("./pg.server");
  const pg = getPg();
  if (!pg) return "Source ages could not be read for this email.";
  const ist = (iso: string | null | undefined) =>
    iso
      ? new Date(iso).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata",
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "never";
  try {
    const [tm, ledger, edge] = await Promise.all([
      pgSelect<{ synced_at: string }[]>(
        pg,
        "/tm_payments?select=synced_at&order=synced_at.desc&limit=1",
      ),
      pgSelect<{ finished_at: string | null }[]>(
        pg,
        "/sync_runs?select=finished_at&source=eq.ledger&order=finished_at.desc&limit=1",
      ),
      pgSelect<{ business_date: string }[]>(
        pg,
        "/ledger_inflow?select=business_date&order=business_date.desc&limit=1",
      ),
    ]);
    return `Where the data stands: course payments last read ${ist(tm[0]?.synced_at)} (read every hour); the accounts collections sheet last imported ${ist(ledger[0]?.finished_at)} and typed up to ${edge[0]?.business_date ?? "an unknown day"}.`;
  } catch {
    return "Source ages could not be read for this email.";
  }
}

/**
 * A sale price is never assumed. Offers recur and overseas buyers pay a
 * different amount, so the month is reported on the cash actually received.
 */
async function priceMixLines(day: string): Promise<string[]> {
  const pg = getPg();
  if (!pg) return [];
  const start = `${day.slice(0, 7)}-01`;
  try {
    const [mix, promos] = await Promise.all([
      pgRpc<{ sales: number; full_price_sales: number; discounted_sales: number; overseas_sales: number; cash_received: number; discount_given: number }[]>(
        pg,
        "price_mix_daily",
        { p_start: start, p_end: day },
      ),
      pgRpc<{ name: string; discounted_price: number; list_price: number; sales_in_window: number; discount_in_window: number }[]>(
        pg,
        "promotions_in_window",
        { p_start: start, p_end: day },
      ),
    ]);
    const rows = mix ?? [];
    if (rows.length === 0) return [];
    const sales = rows.reduce((a, r) => a + Number(r.sales ?? 0), 0);
    const cash = rows.reduce((a, r) => a + Number(r.cash_received ?? 0), 0);
    const discounted = rows.reduce((a, r) => a + Number(r.discounted_sales ?? 0), 0);
    const given = rows.reduce((a, r) => a + Number(r.discount_given ?? 0), 0);
    const overseas = rows.reduce((a, r) => a + Number(r.overseas_sales ?? 0), 0);
    if (sales === 0) return [];
    const listed = (await pgSelect<{ value: string | null }[]>(
      pg,
      "/app_settings?select=value&key=eq.l1_list_price",
    ).catch(() => null))?.[0]?.value;
    const listPrice = Number(listed);
    const listText = Number.isFinite(listPrice) ? inr(listPrice) : "the list price";
    const lines = [
      `WHAT BUYERS ACTUALLY PAID: ${int(sales - discounted)} of ${int(sales)} sales this month were at the full ${listText}, ${int(discounted)} were discounted. The average sale actually received was ${inr(cash / sales)} and ${inr(given)} was given away in discounts. No figure in this email assumes a sale price.`,
    ];
    if (overseas > 0) {
      lines.push(
        `- ${int(overseas)} sale${overseas === 1 ? "" : "s"} this month came from overseas and ${overseas === 1 ? "was" : "were"} converted to rupees at the rate stored on the payment, never added as a foreign figure.`,
      );
    }
    for (const p of promos ?? []) {
      if (Number(p.sales_in_window) === 0) continue;
      lines.push(
        `- ${p.name}: ${inr(p.discounted_price)} instead of ${inr(p.list_price)}, used on ${int(p.sales_in_window)} sale${Number(p.sales_in_window) === 1 ? "" : "s"} this month. A change in return this month can be a change in price, not in performance.`,
      );
    }
    return lines;
  } catch {
    return [];
  }
}

export function wrapHtml(sections: Section[], preheader?: string) {
  // The preview text: what the inbox list shows beside the subject. Hidden in
  // the message itself so it is never read twice.
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0">${esc(preheader)}</div>`
    : "";
  return `${pre}<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:560px">${sections
    .map((s) => `<div style="margin-bottom:14px">${s.html}</div>`)
    .join("")}</div>`;
}

function htmlFrom(text: string) {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = text
    .split("\n")
    .map((l) => (l.trim() === "" ? "<div style=\"height:10px\"></div>" : `<div>${esc(l)}</div>`))
    .join("");
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:560px">${body}</div>`;
}

export type SendOutcome = {
  status: "sent" | "already_sent" | "no_key" | "failed";
  businessDate: string;
  subject: string;
  text: string;
  error: string | null;
  messageId?: string | null;
  /** Attention items that had resolved between composing and sending. */
  droppedAttention?: string[];
  imageCount?: number;
  htmlBytes?: number;
};

/**
 * Sends the day's email, once. `force` is for the owner's "send me a test"
 * button and bypasses only the once-a-day guard, never the honesty rules.
 */
export async function sendDailyEmail(
  opts: { force?: boolean; businessDate?: string | undefined; lateNote?: string | undefined } = {},
): Promise<SendOutcome> {
  const pg = getPg();
  if (!pg) throw new Error("backend not configured");
  const day = opts.businessDate ?? yesterdayIst();

  // EVERY run leaves a row, whatever happens after this line. A run that
  // leaves no row is the defect that hid the 25 Sep email for a day.
  let subject: string | null = null;
  let text: string | null = null;
  const write = async (patch: Record<string, unknown>) => {
    try {
      await pgUpsert(
        pg,
        "daily_email_log",
        {
          business_date: day,
          subject,
          body_text: text,
          recipients: RECIPIENTS,
          updated_at: new Date().toISOString(),
          ...patch,
        },
        "business_date",
      );
    } catch (e) {
      console.error("[EQH] daily email log write failed:", e instanceof Error ? e.message : String(e));
    }
  };

  const existing = await pgSelect<DailyEmailStatusRow[]>(
    pg,
    `/daily_email_log?select=status,attempts,sent_at&business_date=eq.${day}`,
  ).catch(() => [] as DailyEmailStatusRow[]);
  const prior = existing?.[0];
  if (!opts.force && prior?.status === "sent") {
    return { status: "already_sent", businessDate: day, subject: null as unknown as string, text: null as unknown as string, error: null };
  }
  const attempts = (prior?.attempts ?? 0) + 1;
  // A prior "sent" row is never downgraded by a forced resend's bookkeeping.
  const keepSent = prior?.status === "sent";
  await write({ status: keepSent ? "sent" : "attempted", attempts, last_error: null });

  try {
    let composed = await composeDailyEmail(day, undefined, { lateNote: opts.lateNote });
    subject = composed.subject;
    text = composed.text;
    await write({ status: keepSent ? "sent" : "attempted", attempts });

    if (!mailKeyPresent()) {
      await write({ status: "no_key", attempts, last_error: "The email connection is not in place yet." });
      return { status: "no_key", businessDate: day, subject, text, error: "The email connection is not in place yet." };
    }

    // Re-check what needs attention at the moment of sending; drop anything
    // already fixed. Never allowed to stop the send.
    let dropped: string[] = [];
    try {
      const fresh = await computeOwnerTrust();
      const stillOpen = new Set((fresh.attention ?? []).map((a) => a.key));
      stillOpen.delete("daily-email-key");
      stillOpen.delete("daily-email");
      stillOpen.delete("daily-email-silent");
      dropped = composed.attentionKeys.filter((k) => !stillOpen.has(k));
      if (dropped.length > 0) {
        const kept = (fresh.attention ?? []).filter(
          (a) => stillOpen.has(a.key) && composed.attentionKeys.includes(a.key),
        );
        composed = await composeDailyEmail(day, { ...fresh, attention: kept }, { lateNote: opts.lateNote });
        subject = composed.subject;
        text = composed.text;
      }
    } catch {
      /* never stops the report */
    }

    try {
      const { fetchSaleSources, raiseDuplicateBuyerItems } = await import("./sale-sources.server");
      await raiseDuplicateBuyerItems(day, await fetchSaleSources(day));
    } catch {
      /* the duplicate note is a nice-to-have; the email is not */
    }

    const { id } = await sendMail({ to: PRIMARY, cc: COPY, subject: composed.subject, text: composed.text, html: composed.html });
    await write({ status: "sent", attempts, sent_at: new Date().toISOString(), last_error: null });
    return {
      status: "sent",
      businessDate: day,
      subject: composed.subject,
      text: composed.text,
      error: null,
      messageId: id || null,
      droppedAttention: dropped,
      imageCount: composed.imageCount,
      htmlBytes: composed.htmlBytes,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    console.error("[EQH] daily email failed:", raw);
    await write({ status: keepSent ? "sent" : "failed", attempts, last_error: raw.slice(0, 500) });
    return { status: "failed", businessDate: day, subject: subject ?? "", text: text ?? "", error: safeMessage(e) };
  }
}

export type DomainState = {
  checked: boolean;
  verified: boolean;
  status: string | null;
  error: string | null;
};

/**
 * The sending path. Email leaves through the owner's Resend connection from an
 * address on thefrequencyproblem.com, which is already verified and sending, so
 * the Gmail copy arrives without waiting on any DNS work for
 * energyqueenshub.com. `verified` here means "this project can send".
 */
export async function emailDomainState(): Promise<DomainState> {
  const ready = mailKeyPresent();
  if (!ready) {
    return {
      checked: true,
      verified: false,
      status: "email connection not added to this project",
      error: null,
    };
  }
  const { sender, reason } = await resolveSender();
  return {
    checked: true,
    verified: true,
    status: `sending as ${sender} — ${reason}`,
    error: null,
  };
}

