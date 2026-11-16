import { uiMessage } from "@/lib/error-copy";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getBreakEvenInputs,
  getMeasuredConversion,
  saveBreakEvenInputs,
} from "@/lib/dashboard.functions";
import { breakEvenCeiling } from "@/lib/breakeven";
import { MetricValue } from "@/components/MetricValue";
import { fromNullable, modelled } from "@/lib/metric";

/**
 * The break-even ceiling is MODELLED, not measured, so its four inputs are
 * editable and its assumptions are visible. The conversion input is seeded
 * from the database, never from a constant — the old "13 buyers per 1,000"
 * spreadsheet figure undercounts sales by roughly 2.3x.
 */
export function BreakEvenSettings() {
  const queryClient = useQueryClient();
  const save = useServerFn(saveBreakEvenInputs);

  const inputsQuery = useQuery({
    queryKey: ["breakeven"],
    queryFn: () => getBreakEvenInputs(),
  });
  const measuredQuery = useQuery({
    queryKey: ["breakeven", "measured"],
    queryFn: () => getMeasuredConversion(),
  });

  const [form, setForm] = useState<{
    l1Price: string;
    backendPrice: string;
    ascensionRate: string;
    buyersPer1000: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const i = inputsQuery.data?.inputs;
    if (i && form === null) {
      setForm({
        l1Price: String(i.l1Price),
        backendPrice: String(i.backendPrice),
        ascensionRate: String(i.ascensionRate),
        buyersPer1000: String(i.buyersPer1000),
      });
    }
  }, [inputsQuery.data, form]);

  if (!form) {
    return (
      <section className="border-border bg-card rounded-md border px-4 py-3 text-xs text-muted-foreground">
        Loading break-even model…
      </section>
    );
  }

  const parsed = {
    l1Price: Number(form.l1Price),
    backendPrice: Number(form.backendPrice),
    ascensionRate: Number(form.ascensionRate),
    buyersPer1000: Number(form.buyersPer1000),
    buyersPer1000Note: inputsQuery.data?.inputs.buyersPer1000Note ?? null,
  };
  const measured = measuredQuery.data;
  // The sale value is the measured realised average, never a typed-in price.
  const ceiling =
    measured?.avgRealised == null
      ? null
      : breakEvenCeiling({ ...parsed, l1Price: measured.avgRealised });

  async function onSave() {
    if (!form) return;
    setSaving(true);
    try {
      const res = await save({
        data: {
          l1Price: Number(form.l1Price),
          backendPrice: Number(form.backendPrice),
          ascensionRate: Number(form.ascensionRate),
          buyersPer1000: Number(form.buyersPer1000),
        },
      });
      if (res.error) toast.error(res.error);
      else {
        toast.success("Break-even model saved — every screen now uses these inputs.");
        await queryClient.invalidateQueries();
      }
    } catch (e) {
      toast.error(uiMessage(e, "the break-even inputs"));
    } finally {
      setSaving(false);
    }
  }

  const field = (key: keyof typeof form, label: string, suffix: string, hint?: ReactNode) => (
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="mt-1 flex items-center gap-1.5">
        <Input
          value={form[key]}
          inputMode="decimal"
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
          className="nums h-7 w-32 text-[12px]"
        />
        <span className="text-[11px] text-muted-foreground">{suffix}</span>
      </span>
      {hint ? <span className="mt-1 block text-[10px] text-muted-foreground">{hint}</span> : null}
    </label>
  );

  return (
    <section className="border-border bg-card rounded-md border">
      <div className="border-border flex items-center gap-2 border-b px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Break-even ceiling
        </h2>
        <span className="bg-warning/15 text-warning rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
          modelled
        </span>
      </div>

      <div className="grid gap-4 px-4 py-4 md:grid-cols-4">
        {field("backendPrice", "Back-end price", "₹ gross")}
        {field("ascensionRate", "Ascension rate", "% of L1 buyers")}
        {field(
          "buyersPer1000",
          "Buyers per 1,000 registrations",
          "buyers",
          measured?.perThousand != null ? (
            <>
              Measured now:{" "}
              <MetricValue metric={fromNullable(measured.perThousand)} format="ratio" /> (
              <MetricValue metric={fromNullable(measured.buyers)} format="int" /> buyers /{" "}
              <MetricValue metric={fromNullable(measured.registrations)} format="int" />{" "}
              registrations)
            </>
          ) : (
            "Measured conversion is not available from the database."
          ),
        )}
      </div>

      <div className="border-border flex flex-wrap items-center gap-4 border-t px-4 py-3">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Maximum defensible cost per registration
          </div>
          <div
            className="nums text-xl font-semibold"
            title={`Modelled: (measured average realised sale + back-end ₹${parsed.backendPrice} × ascension ${parsed.ascensionRate}%) × ${parsed.buyersPer1000} buyers ÷ 1,000 registrations`}
          >
            <MetricValue
              metric={ceiling === null ? fromNullable(null) : modelled(ceiling)}
              format="inr"
            />
          </div>
        </div>
        <p className="max-w-xl text-[11px] leading-relaxed text-muted-foreground">
          Value per registration = (average realised sale + back-end price × ascension rate) ×
          buyers per 1,000 ÷ 1,000. The sale value is never typed in or assumed: it is the average
          cash actually received per Silver sale, read from the collections ledger without GST. If
          no cash has been recorded, no ceiling is shown at all.
        </p>

        <Button
          size="sm"
          className="ml-auto h-7 text-xs"
          disabled={saving}
          onClick={() => void onSave()}
        >
          Save model
        </Button>
      </div>
    </section>
  );
}
