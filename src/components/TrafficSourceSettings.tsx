import { uiMessage } from "@/lib/error-copy";
import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NO_DATA } from "@/lib/format";
import { count } from "@/lib/counts";
import { getUtmSourceMap, saveUtmSourceRule } from "@/lib/attribution.functions";

export const trafficSourceQuery = queryOptions({
  queryKey: ["utm-source-map"],
  queryFn: () => getUtmSourceMap(),
});

const PLATFORMS = ["meta", "google", "zoom", "organic", "podcast", "unknown"] as const;

/**
 * Traffic source rules. These classify the RAW utm_source values found on lead
 * records — they are not agency codes and must never be read as such. The
 * ledger's Source of Student is retired and is not editable anywhere.
 */
export function TrafficSourceSettings() {
  const { data } = useSuspenseQuery(trafficSourceQuery);
  const queryClient = useQueryClient();
  const save = useServerFn(saveUtmSourceRule);
  const [draft, setDraft] = useState<Record<string, { platform: string; is_paid: boolean }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const commit = async (raw: string, platform: string, is_paid: boolean) => {
    setBusy(raw);
    try {
      await save({ data: { raw, platform, is_paid } });
      await queryClient.invalidateQueries({ queryKey: ["utm-source-map"] });
      await queryClient.invalidateQueries({ queryKey: ["ledger-attribution"] });
      toast.success(`${raw} → ${platform}${is_paid ? " (paid)" : ""}`);
    } catch (error) {
      toast.error(uiMessage(error, "the traffic source list"));
    } finally {
      setBusy(null);
    }
  };

  const row = (
    raw: string,
    platform: string,
    isPaid: boolean,
    note?: string | null,
    leads?: number,
  ) => {
    const d = draft[raw] ?? { platform, is_paid: isPaid };
    return (
      <tr key={raw} className="border-t border-border/60">
        <td className="px-3 py-1 font-mono">{raw}</td>
        <td className="px-3 py-1">
          <select
            className="h-7 rounded border border-input bg-background px-1 text-[12px]"
            value={d.platform}
            onChange={(e) => setDraft((p) => ({ ...p, [raw]: { ...d, platform: e.target.value } }))}
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </td>
        <td className="px-3 py-1">
          <label className="flex items-center gap-1 text-[11px]">
            <input
              type="checkbox"
              checked={d.is_paid}
              onChange={(e) =>
                setDraft((p) => ({ ...p, [raw]: { ...d, is_paid: e.target.checked } }))
              }
            />
            paid traffic
          </label>
        </td>
        <td className="px-3 py-1 text-[11px] text-muted-foreground">
          {note ?? (leads === undefined ? "" : `${count(leads)} leads`)}
        </td>
        <td className="px-3 py-1 text-right">
          <Button
            size="sm"
            variant="outline"
            disabled={busy === raw}
            onClick={() => void commit(raw, d.platform, d.is_paid)}
          >
            Save
          </Button>
        </td>
      </tr>
    );
  };

  return (
    <section>
      <h2 className="mb-1 text-[12px] font-semibold">Traffic source rules</h2>
      <p className="mb-2 max-w-3xl text-[11px] text-muted-foreground">
        Classifies the raw <span className="font-mono">utm_source</span> values carried by lead
        records. A sale counts as performance marketing only when the buyer's email matches a lead
        record marked <span className="font-medium text-foreground">paid traffic</span> here (or
        carrying an ad/campaign id). These are platforms and ad accounts — not agencies.{" "}
        <span className="font-mono">RituAgarwal2</span> is an ad account and several agencies have
        run inside it. The accounts ledger's Source of Student is retired and is never used.
      </p>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[12px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">utm_source</th>
              <th className="px-3 py-1.5 text-left font-medium">Platform</th>
              <th className="px-3 py-1.5 text-left font-medium">Counts as paid</th>
              <th className="px-3 py-1.5 text-left font-medium">Note</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {data.rules.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">
                  {NO_DATA}
                </td>
              </tr>
            ) : (
              [...data.rules]
                .sort((a, b) => a.raw.localeCompare(b.raw))
                .map((r) => row(r.raw, r.platform, r.is_paid, r.note))
            )}
            {[...data.unmapped]
              .sort((a, b) => a.raw.localeCompare(b.raw))
              .map((u) => row(u.raw, "unknown", false, null, u.leads))}
          </tbody>
        </table>
      </div>
      {data.unmapped.length > 0 ? (
        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
          {count(data.unmapped.length)} tracking values seen on leads have no rule yet. Until they
          do, they count as non-paid — never as an agency's result.
        </p>
      ) : null}
      <AddRule
        onSaved={() => void queryClient.invalidateQueries({ queryKey: ["utm-source-map"] })}
      />
    </section>
  );
}

function AddRule({ onSaved }: { onSaved: () => void }) {
  const save = useServerFn(saveUtmSourceRule);
  const [raw, setRaw] = useState("");
  const [platform, setPlatform] = useState("meta");
  const [isPaid, setIsPaid] = useState(true);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input
        value={raw}
        placeholder="new utm_source value"
        className="h-8 w-56 text-[12px]"
        onChange={(e) => setRaw(e.target.value)}
      />
      <select
        className="h-8 rounded border border-input bg-background px-2 text-[12px]"
        value={platform}
        onChange={(e) => setPlatform(e.target.value)}
      >
        {PLATFORMS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1 text-[11px]">
        <input type="checkbox" checked={isPaid} onChange={(e) => setIsPaid(e.target.checked)} />
        paid traffic
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={!raw.trim()}
        onClick={async () => {
          try {
            await save({ data: { raw, platform, is_paid: isPaid } });
            setRaw("");
            onSaved();
            toast.success("Rule added");
          } catch (error) {
            toast.error(uiMessage(error, "the traffic source list"));
          }
        }}
      >
        Add rule
      </Button>
    </div>
  );
}
