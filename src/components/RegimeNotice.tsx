import type { RegimeCrossing } from "@/lib/regime";

/**
 * The change-of-team notice. Shown wherever a window, or the comparison behind
 * it, crosses the day a team stopped buying.
 */
export function RegimeNotice({ crossings }: { crossings: RegimeCrossing[] }) {
  if (!crossings.length) return null;
  const c = crossings[0]!;

  return (
    <span
      className="bg-warning/10 text-warning flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px]"
      title={c.plain}
    >
      <span className="font-semibold uppercase tracking-wider">team change</span>
      <span>
        {c.where === "window" ? "this window spans " : "this comparison spans "}
        {c.label} ({c.boundary_date}) — part of the change is a change of who is buying, not of
        performance
      </span>
    </span>
  );
}
