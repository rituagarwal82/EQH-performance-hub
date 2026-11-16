/**
 * THE MONDAY NOTE.
 *
 * Sent after the daily email on Mondays. Same honesty rules: every figure is
 * read from the stored tables the screens read, nothing is estimated, and a
 * figure that is not in yet is named rather than printed as a zero.
 */

import {
  adsTableSection,
  AGENCY_NAMES,
  fetchAdRows,
  inr,
  int,
  sectionFromLines,
  type Section,
} from "./email-blocks.server";
import { wrapHtml, yesterdayIst } from "./daily-email.server";
import { getPg, pgRpc, pgSelect, pgUpsert } from "./pg.server";
import { safeMessage } from "./safe-error";

const APP_URL = "https://id-preview--99936e18-5a56-46c8-ac3a-3a284371d25c.lovable.app";

type AgencyRow = {
  agency_code: string | null;
  registrations: number;
  attended: number;
  show_up_pct: number | null;
  sales: number;
  buyers: number;
  later_spend_90d: number;
};

const shift = (d: string, days: number) => {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

const word = (now: number, prev: number, unit: string) => {
  if (prev === 0) return `${unit} ${int(now)} (no week before to compare)`;
  const diff = now - prev;
  if (diff === 0) return `${unit} ${int(now)}, level with the week before`;
  return `${unit} ${int(now)}, ${diff > 0 ? "up" : "down"} ${int(Math.abs(diff))} on the week before`;
};

export type ComposedWeekly = {
  businessDate: string;
  subject: string;
  text: string;
  html: string;
};

export async function composeWeeklyEmail(businessDate?: string): Promise<ComposedWeekly> {
  const day = businessDate ?? yesterdayIst();
  const pg = getPg();
  if (!pg) throw new Error("backend not configured");

  const [adRows, thisWeek, lastWeek] = await Promise.all([
    fetchAdRows(14),
    pgRpc<AgencyRow[]>(pg, "weekly_agency_rollup", { p_start: shift(day, -6), p_end: day }),
    pgRpc<AgencyRow[]>(pg, "weekly_agency_rollup", { p_start: shift(day, -13), p_end: shift(day, -7) }),
  ]);

  const sections: Section[] = [];
  sections.push(
    sectionFromLines([
      `The week to ${day}, in one place: which ads paid for themselves, who turned up, and what buyers spent afterwards.`,
    ]),
  );

  sections.push(adsTableSection(adRows, 10000, 14));

  const rows = (thisWeek ?? []).filter((r) => r.registrations > 0 || r.sales > 0);
  const lines = ["EACH TEAM THIS WEEK"];
  for (const r of rows.sort((a, b) => b.registrations - a.registrations)) {
    const prev = (lastWeek ?? []).find((x) => x.agency_code === r.agency_code);
    const name = AGENCY_NAMES[r.agency_code ?? ""] ?? "Source not recorded";
    const show =
      r.show_up_pct === null
        ? "show-up not available"
        : `${r.show_up_pct}% turned up (${int(r.attended)} of ${int(r.registrations)})`;
    const later =
      r.buyers === 0
        ? "no buyers this week, so nothing later to report"
        : Number(r.later_spend_90d) === 0
          ? "their buyers have spent nothing further yet"
          : `their buyers went on to spend ${inr(Number(r.later_spend_90d))} within 90 days`;
    lines.push(`- ${name}: ${word(r.registrations, prev?.registrations ?? 0, "registrations")}.`);
    lines.push(`  ${show}. ${word(r.sales, prev?.sales ?? 0, "Silver sales")}. ${later}.`);
  }
  if (rows.length === 0) lines.push("- No registrations or sales were recorded this week.");
  sections.push(sectionFromLines(lines));

  sections.push(sectionFromLines([`Open the engine: ${APP_URL}`]));

  return {
    businessDate: day,
    subject: `EQH weekly — week to ${day}`,
    text: sections.map((s) => s.text.join("\n")).join("\n\n"),
    html: wrapHtml(sections),
  };
}

export async function sendWeeklyEmail(): Promise<{
  status: "sent" | "already_sent" | "no_key" | "failed";
  subject: string;
  text: string;
  error: string | null;
}> {
  const pg = getPg();
  if (!pg) throw new Error("backend not configured");
  const composed = await composeWeeklyEmail();
  const rowDate = `${composed.businessDate}`;

  const existing = await pgSelect<{ status: string }[]>(
    pg,
    `/weekly_email_log?select=status&business_date=eq.${rowDate}`,
  ).catch(() => []);
  if (existing?.[0]?.status === "sent") {
    return { status: "already_sent", subject: composed.subject, text: composed.text, error: null };
  }

  const { mailKeyPresent, sendMail } = await import("./resend.server");
  const keyPresent = mailKeyPresent();
  const { PRIMARY, COPY } = await import("./daily-email.server");

  const write = async (patch: Record<string, unknown>) =>
    pgUpsert(
      pg,
      "weekly_email_log",
      {
        business_date: rowDate,
        subject: composed.subject,
        body_text: composed.text,
        recipients: [...PRIMARY, ...COPY],
        updated_at: new Date().toISOString(),
        ...patch,
      },
      "business_date",
    ).catch(() => undefined);

  if (!keyPresent) {
    await write({ status: "no_key", last_error: "The email connection is not in place yet." });
    return {
      status: "no_key",
      subject: composed.subject,
      text: composed.text,
      error: "The email connection is not in place yet.",
    };
  }

  try {
    await sendMail({
      to: PRIMARY,
      cc: COPY,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
    });
    await write({ status: "sent", sent_at: new Date().toISOString(), last_error: null });
    return { status: "sent", subject: composed.subject, text: composed.text, error: null };
  } catch (e) {
    await write({ status: "failed", last_error: safeMessage(e).slice(0, 500) });
    return { status: "failed", subject: composed.subject, text: composed.text, error: safeMessage(e) };
  }
}
