import { uiMessage } from "@/lib/error-copy";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getOffDays, saveOffDays } from "@/lib/zoom.functions";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Days on which no webinar was scheduled. An off day is a FACT, not a gap:
 * the show-up screens render these neutral ("no webinar scheduled") instead of
 * the amber "no session recorded in this slot" warning, which stays reserved
 * for days where a webinar ran and we failed to capture it.
 */
export function WebinarOffDays() {
  const queryClient = useQueryClient();
  const save = useServerFn(saveOffDays);
  const query = useQuery({ queryKey: ["webinar-off-days"], queryFn: () => getOffDays() });

  const [text, setText] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (query.data && text === null) setText(query.data.days.join(", "));
  }, [query.data, text]);

  const parsed = (text ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const invalid = parsed.filter((d) => !DATE.test(d));

  async function onSave() {
    if (invalid.length) {
      toast.error(`Not a date in YYYY-MM-DD form: ${invalid.join(", ")}`);
      return;
    }
    setSaving(true);
    try {
      const res = await save({ data: { days: parsed } });
      setText(res.days.join(", "));
      toast.success("Off days saved — those dates now read as scheduled downtime.");
      await queryClient.invalidateQueries();
    } catch (e) {
      toast.error(uiMessage(e, "the off-days list"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border-border bg-card rounded-md border">
      <div className="border-border border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Webinar off days
        </h2>
      </div>
      <div className="flex flex-wrap items-end gap-3 px-4 py-4">
        <label className="block flex-1 min-w-[320px]">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Business dates with no webinar scheduled
          </span>
          <Input
            value={text ?? ""}
            placeholder="2026-08-15, 2026-08-28"
            onChange={(e) => setText(e.target.value)}
            className="nums mt-1 h-7 text-[12px]"
          />
          <span className="mt-1 block text-[10px] text-muted-foreground">
            Comma-separated, YYYY-MM-DD. These days render neutral as “no webinar scheduled”; every
            other day with a missing slot stays flagged amber as a capture gap.
          </span>
        </label>
        <Button
          size="sm"
          className="h-7 text-xs"
          disabled={saving || text === null}
          onClick={() => void onSave()}
        >
          Save off days
        </Button>
      </div>
    </section>
  );
}
