/** What the app shows about the owner's daily email: its last state, and a way
 * to preview or send it by hand. */

import { createServerFn } from "@tanstack/react-start";

import { safeMessage } from "./safe-error";

export type DailyEmailState = {
  configured: boolean;
  keyPresent: boolean;
  recipients: string[];
  primary: string[];
  copy: string[];
  domain: { checked: boolean; verified: boolean; status: string | null; error: string | null };
  last: {
    business_date: string;
    status: string;
    subject: string | null;
    body_text: string | null;
    attempts: number;
    last_error: string | null;
    sent_at: string | null;
  } | null;
  preview: { subject: string; text: string } | null;
  error: string | null;
};

const EMPTY: DailyEmailState = {
  configured: false,
  keyPresent: false,
  recipients: [],
  primary: [],
  copy: [],
  domain: { checked: false, verified: false, status: null, error: null },
  last: null,
  preview: null,
  error: null,
};

export const getDailyEmailState = createServerFn({ method: "GET" }).handler(
  async (): Promise<DailyEmailState> => {
    const { getPg, pgSelect } = await import("./pg.server");
    const { composeDailyEmail, emailDomainState, PRIMARY, COPY } = await import(
      "./daily-email.server"
    );
    const pg = getPg();
    if (!pg) return EMPTY;

    try {
      const [rows, preview, domain] = await Promise.all([
        pgSelect<DailyEmailState["last"][]>(
          pg,
          "/daily_email_log?select=business_date,status,subject,body_text,attempts,last_error,sent_at&order=business_date.desc&limit=1",
        ).catch(() => []),
        composeDailyEmail().catch(() => null),
        emailDomainState().catch(() => EMPTY.domain),
      ]);
      return {
        configured: true,
        keyPresent: Boolean(process.env["RESEND_API_KEY"]),
        recipients: [...PRIMARY, ...COPY],
        primary: PRIMARY,
        copy: COPY,
        domain,
        last: rows?.[0] ?? null,
        preview: preview ? { subject: preview.subject, text: preview.text } : null,
        error: null,
      };
    } catch (e) {
      return { ...EMPTY, configured: true, error: safeMessage(e) };
    }
  },
);

/** "Send it to me now" — same email, same honesty rules, no once-a-day guard. */
export const sendDailyEmailNow = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ status: string; error: string | null }> => {
    const { sendDailyEmail } = await import("./daily-email.server");
    try {
      const out = await sendDailyEmail({ force: true });
      return { status: out.status, error: out.error };
    } catch (e) {
      return { status: "failed", error: safeMessage(e) };
    }
  },
);
