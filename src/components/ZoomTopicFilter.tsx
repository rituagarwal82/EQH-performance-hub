import { uiMessage } from "@/lib/error-copy";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { getWebinars, saveTopicMatch } from "@/lib/zoom.functions";

/**
 * The L1 topic filter is administration, not reading. It lives here so
 * /show-up can be about whether people turned up and stayed.
 */
export function ZoomTopicFilter() {
  const save = useServerFn(saveTopicMatch);
  const { data } = useQuery({
    queryKey: ["zoom-topic-filter"],
    queryFn: () => getWebinars({ data: {} }),
  });
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!loaded && data?.topicMatch) {
      setDraft(data.topicMatch);
      setLoaded(true);
    }
  }, [data?.topicMatch, loaded]);

  async function onSave() {
    const value = draft.trim();
    if (value.length < 2) {
      toast.error("The topic filter must be at least 2 characters.");
      return;
    }
    try {
      await save({ data: { value } });
      toast.success(`Topic filter saved: “${value.toLowerCase()}”. Re-run the sync to apply it.`);
    } catch (e) {
      toast.error(uiMessage(e, "the webinar filter"));
    }
  }

  return (
    <section className="border-border bg-card rounded-md border px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[22rem] flex-1">
          <label
            htmlFor="topic-match"
            className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            L1 topic filter (case-insensitive substring)
          </label>
          <input
            id="topic-match"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={data?.topicMatch ?? "no data"}
            className="border-input bg-background mt-1.5 w-full rounded border px-2 py-1.5 font-mono text-sm"
          />
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => void onSave()}>
          Save filter
        </Button>
        <p className="text-[11px] text-muted-foreground md:max-w-md">
          {data?.topicMatchDescription ??
            "Only Zoom sessions whose topic contains this phrase are ingested as L1 webinars."}
        </p>
      </div>
    </section>
  );
}
