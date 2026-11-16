import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { UiError, RouteError } from "@/components/UiError";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Save } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { DailyEmailPanel } from "@/components/DailyEmailPanel";
import { BreakEvenSettings } from "@/components/BreakEvenSettings";
import { AgencyCodeSettings, agencyMapQuery } from "@/components/AgencyCodeSettings";
import { TrafficSourceSettings, trafficSourceQuery } from "@/components/TrafficSourceSettings";

import { WebinarOffDays } from "@/components/WebinarOffDays";
import { ZoomTopicFilter } from "@/components/ZoomTopicFilter";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { NO_DATA } from "@/lib/format";
import { count } from "@/lib/counts";
import { MetricValue } from "@/components/MetricValue";
import { fromNullable } from "@/lib/metric";
import {
  getProducts,
  saveProductClassification,
  type ProductRow,
  type ProductTier,
} from "@/lib/products.functions";
import { safeMessage } from "@/lib/safe-error";

const productsQuery = queryOptions({
  queryKey: ["products"],
  queryFn: () => getProducts(),
});

export const Route = createFileRoute("/_authenticated/settings")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(productsQuery),
      context.queryClient.ensureQueryData(trafficSourceQuery),
      context.queryClient.ensureQueryData(agencyMapQuery),
    ]);
  },

  head: () => ({
    meta: [
      { title: "Settings — EQH Performance Engine" },
      {
        name: "description",
        content:
          "Reporting settings for Energy Queens Hub: traffic sources, team codes, break-even inputs, webinar off days, the Zoom topic filter, and which products count as a Silver (L1) sale.",
      },
      { property: "og:title", content: "Settings — EQH Performance Engine" },
      {
        property: "og:description",
        content: "Every reporting setting in one place, each panel saving its own changes.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SettingsPage,
    errorComponent: ({ error, reset }) => (
    <RouteError error={error} reset={reset} subject="settings" where="src/routes/settings.tsx" />
  ),
  notFoundComponent: () => <div className="p-8 text-sm text-muted-foreground">Not found.</div>,
});

const TIERS: { value: ProductTier | ""; label: string }[] = [
  { value: "", label: "unset" },
  { value: "L1_SILVER", label: "L1 Silver" },
  { value: "L2", label: "L2" },
  { value: "L3_DIAMOND", label: "L3 Diamond" },
  { value: "OTHER", label: "Other" },
];

type Draft = { tier: ProductTier | null; counts_as_sale: boolean };

function SettingsPage() {
  const { data } = useSuspenseQuery(productsQuery);
  const qc = useQueryClient();
  const save = useServerFn(saveProductClassification);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);

  const products = data.products;

  const current = (p: ProductRow): Draft =>
    drafts[p.mango_id] ?? { tier: p.tier, counts_as_sale: p.counts_as_sale };

  const dirty = useMemo(
    () =>
      products.filter((p) => {
        const d = drafts[p.mango_id];
        return d && (d.tier !== p.tier || d.counts_as_sale !== p.counts_as_sale);
      }),
    [products, drafts],
  );

  const silverCount = products.filter(
    (p) => current(p).tier === "L1_SILVER" && current(p).counts_as_sale,
  ).length;

  function update(id: string, patch: Partial<Draft>, base: Draft) {
    setDrafts((prev) => ({ ...prev, [id]: { ...base, ...patch } }));
  }

  async function onSave() {
    setSaving(true);
    const id = toast.loading("Saving product classification…");
    try {
      const result = await save({
        data: {
          changes: dirty.map((p) => ({
            mango_id: p.mango_id,
            ...current(p),
          })),
        },
      });
      toast.success(`Saved ${count(result.saved)} product(s).`, { id });
      setDrafts({});
      await qc.invalidateQueries();
    } catch (e) {
      toast.error(safeMessage(e), { id });
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell topBar={<span className="text-[13px] font-semibold tracking-tight">Settings</span>}>
      <div className="space-y-6 px-6 py-5">
        <DailyEmailPanel />
        <TrafficSourceSettings />
        <AgencyCodeSettings />

        <BreakEvenSettings />
        <WebinarOffDays />
        <ZoomTopicFilter />

        <div className="border-border mt-6 flex flex-wrap items-center gap-3 border-t pt-5">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Products
            </h2>
            <p className="mt-1 text-sm">
              Tick the products that count as a Silver (L1) sale. Only ticked products will appear
              in the performance figures.
            </p>
            <p className="nums mt-1.5 text-xs font-medium text-muted-foreground">
              {count(silverCount)} products ticked as L1 Silver
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => void onSave()}
            disabled={saving || dirty.length === 0}
            className="ml-auto h-7 shrink-0 gap-1.5 text-xs"
          >
            <Save className="size-3.5" />
            Save products {dirty.length > 0 ? `(${dirty.length})` : ""}
          </Button>
        </div>

        {data.error ? (
          <div className="border-destructive/40 bg-destructive/10 mt-4 rounded-md border px-4 py-3 text-xs text-destructive">
            <UiError detail={data.error} where={"src/routes/settings.tsx"} />
          </div>
        ) : null}

        {products.length === 0 ? (
          <div className="border-border bg-card mt-5 rounded-md border px-6 py-10 text-center">
            <p className="text-sm font-medium">No products yet.</p>
            <p className="mt-2 text-xs text-muted-foreground">
              The TagMango catalogue has not been imported. Nothing is invented here — rows appear
              only once real products are loaded.
            </p>
          </div>
        ) : (
          <div className="border-border bg-card mt-5 overflow-x-auto rounded-md border">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                  <th className="px-3 py-1.5 text-left font-medium">Product</th>
                  <th className="px-3 py-1.5 text-left font-medium">Type</th>
                  <th className="px-3 py-1.5 text-right font-medium">Price</th>
                  <th className="px-3 py-1.5 text-right font-medium">Subscribers</th>
                  <th className="px-3 py-1.5 text-left font-medium">Tier</th>
                  <th className="px-3 py-1.5 text-center font-medium">Counts as a sale</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const d = current(p);
                  return (
                    <tr key={p.mango_id} className="border-border/60 border-b last:border-b-0">
                      <td className="px-3 py-1.5">
                        <div className="font-medium">{p.title}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">
                          {p.mango_id}
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        {p.product_type ?? (
                          <span className="italic text-muted-foreground/70">{NO_DATA}</span>
                        )}
                      </td>
                      <td className="nums px-4 py-2.5 text-right">
                        <MetricValue metric={fromNullable(p.price)} format="inr" />
                      </td>
                      <td className="nums px-4 py-2.5 text-right">
                        <MetricValue metric={fromNullable(p.subscriber_count)} format="int" />
                      </td>
                      <td className="px-3 py-1.5">
                        <select
                          aria-label={`Tier for ${p.title}`}
                          value={d.tier ?? ""}
                          onChange={(e) =>
                            update(
                              p.mango_id,
                              { tier: (e.target.value || null) as ProductTier | null },
                              d,
                            )
                          }
                          className="border-border bg-background rounded border px-2 py-1 text-xs"
                        >
                          {TIERS.map((t) => (
                            <option key={t.label} value={t.value}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <Switch
                          aria-label={`Counts as a sale: ${p.title}`}
                          checked={d.counts_as_sale}
                          onCheckedChange={(v) => update(p.mango_id, { counts_as_sale: v }, d)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
          Catalogue sync uses TagMango's REST API and only writes products returned by TagMango.
          Product classifications are preserved when catalogue fields refresh.
        </p>
      </div>
    </AppShell>
  );
}
