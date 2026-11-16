import { useQuery } from "@tanstack/react-query";

import { getAdPerformance, type AdPerfRow } from "@/lib/ad-performance.functions";
import { formatINR, formatInt, NO_DATA } from "@/lib/format";

/** The owner's own thresholds — kept identical to the email's. */
const STOP_ABOVE = 12000;
const SCALE_BELOW = 9000;
const MIN_REGS = 30;

const TEAM_NAMES: Record<string, string> = {
  SD: "Sabhi Digital",
  RJ: "Rajdeep (in-house)",
  PRM: "Parami",
  SX: "ScaleX (closed)",
};

function verdict(r: AdPerfRow): string {
  if (r.registrations < MIN_REGS) return "Too early";
  if (r.sales === 0) return "Consider stopping";
  const cps = r.cost_per_sale ?? 0;
  if (cps > STOP_ABOVE) return "Consider stopping";
  if (cps < SCALE_BELOW) return "Consider scaling";
  return "Holding steady";
}

function adsManagerLink(r: AdPerfRow) {
  const act = (r.account_id ?? "").replace(/^act_/, "");
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${act}&selected_ad_ids=${r.entity_id}`;
}

/**
 * Every ad that spent in the window, ranked by cost per sale — the same rows,
 * from the same stored function, that the daily email sends.
 */
export function AdPerformanceTable({
  days = 14,
  sort = "cost_per_sale",
}: {
  days?: number;
  sort?: "cost_per_sale" | "spend";
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["ad-performance", days],
    queryFn: () => getAdPerformance({ data: { days } }),
  });

  const rows = (data?.rows ?? [])
    .filter((r) => r.spend > 0)
    .sort((a, b) => {
      if (sort === "spend") return b.spend - a.spend;
      if (a.cost_per_sale === null && b.cost_per_sale === null) return b.spend - a.spend;
      if (a.cost_per_sale === null) return 1;
      if (b.cost_per_sale === null) return -1;
      return a.cost_per_sale - b.cost_per_sale;
    });

  return (
    <section className="border-border bg-card rounded-md border">
      <div className="border-border flex flex-wrap items-baseline gap-2 border-b px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Every ad, last {days} days
        </h2>
        <span className="text-[11px] text-muted-foreground">
          the same rows the daily email sends · no verdict below {MIN_REGS} registrations
        </span>
      </div>

      {isError || data?.error ? (
        <p className="px-3 py-4 text-[12px] text-destructive">
          The ad figures could not be read — this is not an empty list.
        </p>
      ) : isLoading ? (
        <p className="px-3 py-4 text-[12px] text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-4 text-[12px] text-muted-foreground">
          No ad spent in this window.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="bg-muted/60 border-border text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:border-b [&>th]:px-3 [&>th]:py-1.5 [&>th]:font-medium">
                <th className="text-left">Ad</th>
                <th className="text-left">Team</th>
                <th className="text-right">Spend</th>
                <th className="text-right">Registrations</th>
                <th className="text-right">Cost / registration</th>
                <th className="text-right">Sales</th>
                <th className="text-right">Cost / sale</th>
                <th className="text-left">What to do</th>
                <th className="text-left">Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.entity_id}
                  className="border-border [&>td]:border-b [&>td]:px-3 [&>td]:py-1.5"
                >
                  <td>
                    <div className="flex items-center gap-2">
                      {r.thumbnail_url ? (
                        <img
                          src={r.thumbnail_url}
                          alt=""
                          className="size-9 shrink-0 rounded object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded text-[9px] text-muted-foreground">
                          none
                        </div>
                      )}
                      <span className="max-w-[22rem] truncate font-medium">
                        {r.ad_name ?? r.entity_id}
                      </span>
                    </div>
                  </td>
                  <td className="text-muted-foreground">
                    {TEAM_NAMES[r.agency_code ?? ""] ?? "not recorded"}
                  </td>
                  <td className="nums text-right">{formatINR(r.spend)}</td>
                  <td className="nums text-right">{formatInt(r.registrations)}</td>
                  <td className="nums text-right">
                    {r.cost_per_reg === null ? NO_DATA : formatINR(r.cost_per_reg)}
                  </td>
                  <td className="nums text-right">{formatInt(r.sales)}</td>
                  <td className="nums text-right">
                    {r.cost_per_sale === null ? "no sale yet" : formatINR(r.cost_per_sale)}
                  </td>
                  <td>{verdict(r)}</td>
                  <td className="whitespace-nowrap">
                    {r.permalink_url ? (
                      <a
                        className="underline"
                        href={r.permalink_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Watch
                      </a>
                    ) : (
                      <span className="text-muted-foreground">not public</span>
                    )}
                    {" · "}
                    <a
                      className="underline"
                      href={adsManagerLink(r)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Ads Manager
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
