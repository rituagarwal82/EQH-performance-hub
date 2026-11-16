import { uiMessage } from "@/lib/error-copy";
import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { UiError } from "@/components/UiError";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteAgencyRule, getAgencyMap, saveAgencyRule } from "@/lib/agency.functions";

export const agencyMapQuery = queryOptions({
  queryKey: ["utm-agency-map"],
  queryFn: () => getAgencyMap(),
});

/**
 * Team codes read off the utm_source suffix. A lead only carries a team code
 * when its utm_source ends with one of these suffixes — plain FACEBOOK and
 * Meta stay unassigned on purpose.
 */
export function AgencyCodeSettings() {
  const { data } = useSuspenseQuery(agencyMapQuery);
  const queryClient = useQueryClient();
  const save = useServerFn(saveAgencyRule);
  const remove = useServerFn(deleteAgencyRule);
  const [suffix, setSuffix] = useState("");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["utm-agency-map"] });

  const add = async () => {
    setBusy(true);
    try {
      await save({ data: { suffix: suffix.trim(), agency_code: code.trim(), label } });
      await refresh();
      setSuffix("");
      setCode("");
      setLabel("");
      toast.success("Team code rule saved");
    } catch (e) {
      toast.error(uiMessage(e, "the team codes"));
    } finally {
      setBusy(false);
    }
  };

  const drop = async (s: string) => {
    setBusy(true);
    try {
      await remove({ data: { suffix: s } });
      await refresh();
      toast.success(`${s} removed`);
    } catch (e) {
      toast.error(uiMessage(e, "the team codes"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="mb-1 text-[12px] font-semibold">Team codes (utm_source suffix)</h2>
      <p className="mb-2 max-w-3xl text-[11px] text-muted-foreground">
        Leads are stamped with a team code when their utm_source ends with one of these suffixes,
        matched case-insensitively and longest suffix first. Anything else stays unassigned — plain{" "}
        <span className="font-mono">FACEBOOK</span> and <span className="font-mono">Meta</span> are
        ambiguous historical templates and are never credited to a team.
      </p>
      {data.error ? (
        <UiError detail={data.error} subject="the team codes" where="agency codes" className="mb-2" />
      ) : null}
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-[12px]">
          <thead className="bg-muted/60 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-1.5 text-left font-medium">Suffix</th>
              <th className="px-3 py-1.5 text-left font-medium">Team code</th>
              <th className="px-3 py-1.5 text-left font-medium">Team</th>
              <th className="px-3 py-1.5 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {data.rules.map((r) => (
              <tr key={r.suffix} className="border-t border-border/60">
                <td className="px-3 py-1 font-mono">{r.suffix}</td>
                <td className="px-3 py-1 font-mono">{r.agency_code}</td>
                <td className="px-3 py-1 text-muted-foreground">{r.label ?? "—"}</td>
                <td className="px-3 py-1 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void drop(r.suffix)}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
            <tr className="border-t border-border/60">
              <td className="px-3 py-1">
                <Input
                  className="h-7 font-mono text-[12px]"
                  placeholder="_PRM"
                  value={suffix}
                  onChange={(e) => setSuffix(e.target.value)}
                />
              </td>
              <td className="px-3 py-1">
                <Input
                  className="h-7 font-mono text-[12px]"
                  placeholder="PRM"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </td>
              <td className="px-3 py-1">
                <Input
                  className="h-7 text-[12px]"
                  placeholder="Parami"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </td>
              <td className="px-3 py-1 text-right">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void add()}>
                  Add
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        New rules apply to leads from the next sync onwards; existing leads keep the code they were
        stamped with until they are re-synced.
      </p>
    </section>
  );
}
