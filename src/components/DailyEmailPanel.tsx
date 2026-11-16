import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { getDailyEmailState, sendDailyEmailNow } from "@/lib/daily-email.functions";

const stateQuery = () =>
  queryOptions({ queryKey: ["daily-email"], queryFn: () => getDailyEmailState() });

function statusSentence(s: {
  status: string;
  business_date: string;
  sent_at: string | null;
  last_error: string | null;
} | null, keyPresent: boolean) {
  if (!s) {
    return keyPresent
      ? "No daily email has gone out yet — the first one sends at the next 6 p.m."
      : "No daily email has gone out yet, because no email key has been added.";
  }
  const when = s.sent_at
    ? new Date(s.sent_at).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  if (s.status === "sent") return `Last email sent ${when} covering ${s.business_date}.`;
  if (s.status === "no_key")
    return "Nothing can be sent yet: no email key has been added. The first email goes out automatically once it is.";
  return `The last attempt (${s.business_date}) did not send. It will be retried at the next run.`;
}

/**
 * The daily email, visible inside the app: what it will say, whether it went
 * out, and a way to send it by hand once the key exists.
 */
export function DailyEmailPanel() {
  const { data } = useQuery(stateQuery());
  const qc = useQueryClient();
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const send = useMutation({
    mutationFn: () => sendDailyEmailNow(),
    onSuccess: (r) => {
      setNote(
        r.status === "sent"
          ? "Sent."
          : r.status === "no_key"
            ? "Nothing was sent: no email key has been added yet."
            : "That did not send. The reason is shown above.",
      );
      void qc.invalidateQueries({ queryKey: ["daily-email"] });
    },
    onError: () => setNote("That did not send."),
  });

  if (!data?.configured) return null;

  return (
    <section className="border-border rounded-md border bg-card p-4">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">Daily email to the owner</h2>
        <span className="text-[11px] text-muted-foreground">6 p.m. India time, every day</span>
      </div>
      <p className="mt-1 text-[13px]">{statusSentence(data.last, data.keyPresent)}</p>
      {data.last?.last_error && data.last.status === "failed" ? (
        <p className="mt-1 text-[12px] text-warning">Reason: {data.last.last_error}</p>
      ) : null}
      <p className="mt-1 text-[11px] text-muted-foreground">
        Goes to {data.primary.join(" and ")}
        {data.copy.length > 0 ? `, copied to ${data.copy.join(" and ")}` : ""}.
      </p>
      <p className="mt-1 text-[12px]">
        {data.domain.verified
          ? `The email goes out through the Resend account already connected to this project. Live sender: ${data.domain.status}. The report is moving to EQH Engine <engine@send.energyqueenshub.com>, a sending address of its own that leaves the business mailbox on energyqueenshub.com untouched; until that address is set up and confirmed, the proven address keeps sending, and the switch happens by itself. Replies go to connect@energyqueenshub.com.`
          : "Nothing can be sent yet: the Resend email account has not been added to this project. Connections are per project, so adding it once here is all that is needed — open Connectors in the sidebar and add the same Resend account the Masterclass project uses. Nothing has to be pasted by hand."}

      </p>

      {data.preview ? (
        <div className="mt-3">
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-[12px] underline text-muted-foreground hover:text-foreground"
          >
            {open ? "Hide" : "Show"} what today's email says
          </button>
          {open ? (
            <div className="border-border mt-2 rounded border bg-background p-3">
              <div className="text-[12px] font-semibold">{data.preview.subject}</div>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-[12px] leading-relaxed">
                {data.preview.text}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" variant="outline" disabled={send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? "Sending…" : "Send it to me now"}
        </Button>
        {note ? <span className="text-[12px] text-muted-foreground">{note}</span> : null}
      </div>
    </section>
  );
}
