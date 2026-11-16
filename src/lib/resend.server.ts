/**
 * THE ONE DOOR EMAIL LEAVES BY.
 *
 * Both the daily email and the Monday note send through the Lovable Resend
 * connection, from an address on a domain that is already verified, so the
 * owner's Gmail copy arrives without waiting on any DNS work.
 */

const GATEWAY = "https://connector-gateway.lovable.dev/resend";

/** The address we move to as soon as its domain is verified. */
export const NEW_SENDER = "EQH Engine <engine@send.energyqueenshub.com>";
export const NEW_SENDER_DOMAIN = "send.energyqueenshub.com";
/** The proven address we keep using until then. */
export const FALLBACK_SENDER = "EQH Engine <engine@thefrequencyproblem.com>";

/** Changeable without a code edit: set RESEND_FROM_EMAIL in the project. */
export const FROM_ADDRESS = () =>
  process.env["RESEND_FROM_EMAIL"] ?? FALLBACK_SENDER;

type DomainRow = { name?: string; status?: string };
let senderCache: { at: number; sender: string; reason: string } | null = null;

/**
 * Which address the next email actually leaves from.
 *
 * An explicit RESEND_FROM_EMAIL always wins. Otherwise we ask the email
 * account whether send.energyqueenshub.com has verified yet and switch to it
 * the moment it has — until then the proven address keeps the mail flowing.
 */
export async function resolveSender(): Promise<{ sender: string; reason: string }> {
  const override = process.env["RESEND_FROM_EMAIL"];
  if (override) return { sender: override, reason: "set explicitly for this project" };

  if (senderCache && Date.now() - senderCache.at < 10 * 60 * 1000) {
    return { sender: senderCache.sender, reason: senderCache.reason };
  }

  let sender = FALLBACK_SENDER;
  let reason =
    "send.energyqueenshub.com has not verified yet, so the proven address keeps sending";
  try {
    const lovableKey = process.env["LOVABLE_API_KEY"];
    const connectionKey = process.env["RESEND_API_KEY"];
    if (lovableKey && connectionKey) {
      const res = await fetch(`${GATEWAY}/domains`, {
        headers: {
          Authorization: `Bearer ${lovableKey}`,
          "X-Connection-Api-Key": connectionKey,
        },
      });
      if (res.ok) {
        const rows = ((await res.json()) as { data?: DomainRow[] }).data ?? [];
        const row = rows.find((d) => d.name === NEW_SENDER_DOMAIN);
        if (row?.status === "verified") {
          sender = NEW_SENDER;
          reason = "send.energyqueenshub.com is verified, so the new address is live";
        } else if (!row) {
          reason =
            "send.energyqueenshub.com has not been added to the email account yet, so the proven address keeps sending";
        }
      }
    }
  } catch {
    // A lookup failure must never stop the report going out.
  }
  senderCache = { at: Date.now(), sender, reason };
  return { sender, reason };
}


/** Replies belong in the business mailbox, not the sending address. */
export const REPLY_TO = "connect@energyqueenshub.com";

/**
 * A one-person internal report should look like one to Gmail: a working
 * unsubscribe that needs no click-through, and nothing that smells of a
 * marketing blast. No tracking pixels, no shortened links, no images.
 */
const UNSUBSCRIBE_URL =
  process.env["EMAIL_UNSUBSCRIBE_URL"] ??
  "https://id-preview--99936e18-5a56-46c8-ac3a-3a284371d25c.lovable.app/api/public/unsubscribe";

export const STANDARD_HEADERS = (): Record<string, string> => ({
  "List-Unsubscribe": `<${UNSUBSCRIBE_URL}>, <mailto:${REPLY_TO}?subject=unsubscribe>`,
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  "Auto-Submitted": "auto-generated",
});

export type MailInput = {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html: string;
};

export function mailKeyPresent(): boolean {
  return Boolean(process.env["RESEND_API_KEY"] && process.env["LOVABLE_API_KEY"]);
}

/** Sends one email and returns the provider's message id. Throws on failure. */
export async function sendMail(input: MailInput): Promise<{ id: string }> {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const connectionKey = process.env["RESEND_API_KEY"];
  if (!lovableKey || !connectionKey) throw new Error("email connection not available");

  const res = await fetch(`${GATEWAY}/emails`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": connectionKey,
    },
    body: JSON.stringify({
      from: (await resolveSender()).sender,
      to: input.to,
      ...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
      reply_to: REPLY_TO,
      subject: input.subject,
      text: input.text,
      html: input.html,
      headers: STANDARD_HEADERS(),
    }),
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${body.slice(0, 300)}`);
  let id = "";
  try {
    id = (JSON.parse(body) as { id?: string }).id ?? "";
  } catch {
    id = "";
  }
  return { id };
}
