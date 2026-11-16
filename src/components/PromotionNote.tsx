/**
 * A plain flag that a period contained a discounted offer, so a change in
 * return is not read as a change in performance.
 */

import { useQuery } from "@tanstack/react-query";

import { formatINR, formatInt } from "@/lib/format";
import { getPriceMix } from "@/lib/promotions.functions";

export function priceMixQueryKey(since: string, until: string) {
  return ["price-mix", since, until] as const;
}

export function PromotionNote({ since, until }: { since: string; until: string }) {
  const { data } = useQuery({
    queryKey: priceMixQueryKey(since, until),
    queryFn: () => getPriceMix({ data: { since, until } }),
    staleTime: 5 * 60_000,
  });

  const promos = data?.inWindow ?? [];
  if (promos.length === 0) return null;

  const daily = data?.daily ?? [];
  const sales = daily.reduce((a, d) => a + Number(d.sales ?? 0), 0);
  const cash = daily.reduce((a, d) => a + Number(d.cash_received ?? 0), 0);
  const discounted = daily.reduce((a, d) => a + Number(d.discounted_sales ?? 0), 0);
  const average = sales > 0 ? cash / sales : null;

  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <p className="font-medium">This period contains a discounted offer.</p>
      <ul className="mt-1 space-y-1 text-muted-foreground">
        {promos.map((p) => (
          <li key={p.code}>
            {p.name} — {formatINR(p.discounted_price)} instead of {formatINR(p.list_price)},{" "}
            {formatInt(p.sales_in_window)} sale{Number(p.sales_in_window) === 1 ? "" : "s"} in this
            period, {formatINR(p.discount_in_window)} given away.
            {p.dates_confirmed ? "" : " Its dates are not confirmed yet."}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-muted-foreground">
        {formatInt(discounted)} of {formatInt(sales)} sales in this period were below the full
        price. The average sale was {average === null ? "no data" : formatINR(average)}
        {promos[0] ? <> against a list price of {formatINR(promos[0].list_price)}</> : null} — a
        change in return here can be a change in price, not in performance. Every money figure uses
        the cash actually received.
      </p>
    </div>
  );
}
