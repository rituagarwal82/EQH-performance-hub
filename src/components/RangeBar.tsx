import { AlertTriangle, CheckCircle2, MoreHorizontal } from "lucide-react";
import { type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RANGE_LABELS, type Range, type RangePreset } from "@/lib/date-range";
import { GRAIN_LABELS, GRAINS, type Density, type Grain } from "@/lib/view-prefs";

export type RangeSearch = {
  range: RangePreset;
  since?: string | undefined;
  until?: string | undefined;
  compare: boolean;
  agency?: string | undefined;
  /** Day · Week · Month, shared across the four funnel surfaces via the URL. */
  grain?: Grain | undefined;
  /** Brief ⇄ Working density, mirrored here so a link carries the reader's mode. */
  view?: Density | undefined;
};

/**
 * Top bar = WHAT AM I LOOKING AT. Range, comparison, freshness, data jobs.
 *
 * Three ranges are visible because three cover almost every reading; the rest
 * sit one tap away rather than spending width every day. The team selector is
 * gone from here entirely: a team slice changes what most figures on a screen
 * MEAN, so it belongs on the screens that can honour it, not on every screen.
 */
const VISIBLE_PRESETS: RangePreset[] = ["yesterday", "last7", "this_month"];
const MENU_PRESETS: RangePreset[] = ["last14", "last30", "last_month", "this_year", "custom"];

export function RangeBar({
  title,
  search,
  range,
  onChange,
  right,
  showCompare = false,
}: {
  title: string;
  search: RangeSearch;
  range: Range;
  onChange: (next: Partial<RangeSearch>) => void;
  right?: ReactNode;
  /** Only screens that actually draw a prior-period change offer the control. */
  showCompare?: boolean;
}) {
  const inMenu = MENU_PRESETS.includes(search.range);

  return (
    <>
      <span className="shrink-0 text-[13px] font-semibold tracking-tight">{title}</span>

      <div className="flex shrink-0 items-center gap-0.5">
        {VISIBLE_PRESETS.map((p) => (
          <button
            key={p}
            onClick={() => onChange({ range: p })}
            className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              search.range === p
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {p === "last7" ? "7 days" : RANGE_LABELS[p]}
          </button>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="More date ranges"
            className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              inMenu
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {inMenu ? RANGE_LABELS[search.range] : <MoreHorizontal className="size-3.5" />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {MENU_PRESETS.map((p) => (
              <DropdownMenuCheckboxItem
                key={p}
                checked={search.range === p}
                onCheckedChange={() =>
                  onChange(
                    p === "custom"
                      ? { range: p, since: range.since, until: range.until }
                      : { range: p },
                  )
                }
                className="text-[12px]"
              >
                {RANGE_LABELS[p]}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {search.range === "custom" ? (
        <div className="flex shrink-0 items-center gap-1">
          <Input
            type="date"
            value={range.since}
            onChange={(e) => onChange({ since: e.target.value })}
            className="nums h-7 w-[130px] text-[11px]"
          />
          <span className="text-[11px] text-muted-foreground">→</span>
          <Input
            type="date"
            value={range.until}
            onChange={(e) => onChange({ until: e.target.value })}
            className="nums h-7 w-[130px] text-[11px]"
          />
        </div>
      ) : null}

      {showCompare ? (
        <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={search.compare}
            onChange={(e) => onChange({ compare: e.target.checked })}
            className="size-3.5 accent-[var(--primary)]"
          />
          Compare with the period before
        </label>
      ) : null}

      {right ? <div className="ml-auto flex shrink-0 items-center gap-2">{right}</div> : null}
    </>
  );
}

/**
 * Day · Week · Month. Every grain aggregates the same daily fact rows, so the
 * control changes the bucketing and nothing else. Working mode only — a Brief
 * reader is answering a question, not re-bucketing a series.
 */
export function GrainSwitch({ grain, onChange }: { grain: Grain; onChange: (g: Grain) => void }) {
  return (
    <div className="border-border flex shrink-0 items-center rounded border p-0.5">
      {GRAINS.map((g) => (
        <button
          key={g}
          onClick={() => onChange(g)}
          aria-pressed={grain === g}
          className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
            grain === g
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          }`}
        >
          {GRAIN_LABELS[g]}
        </button>
      ))}
    </div>
  );
}

/**
 * Brief shows fewer rows, fewer columns and one chart. It never softens a
 * number, a metric state, a freshness badge or an empty state.
 *
 * Some screens have a single view (there is nothing to shorten). There the
 * switch is shown as unavailable with the reason, rather than looking broken.
 */
export function DensitySwitch({
  density,
  onChange,
  available = true,
}: {
  density: Density;
  onChange: (d: Density) => void;
  available?: boolean;
}) {
  const hint = available
    ? "Brief — the short view. Working — full detail. Same numbers either way."
    : "This screen has one view only — there is nothing extra to hide.";
  return (
    <div
      className={`border-border flex shrink-0 items-center rounded border p-0.5 ${
        available ? "" : "opacity-50"
      }`}
      title={hint}
      aria-label={hint}
    >
      {(["brief", "working"] as const).map((d) => (
        <button
          key={d}
          onClick={() => onChange(d)}
          disabled={!available}
          aria-pressed={density === d}
          aria-label={
            d === "brief"
              ? "Brief — the short view"
              : "Working — full detail"
          }
          title={
            available
              ? d === "brief"
                ? "Brief — the short view"
                : "Working — full detail"
              : hint
          }
          className={`rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-colors ${
            density === d
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          } ${available ? "" : "cursor-not-allowed"}`}
        >
          {d}
        </button>
      ))}
    </div>
  );
}


export function FreshnessBadge({
  stale,
  age,
  status,
  startedAt,
  label = "Meta",
}: {
  stale: boolean;
  age: number | null;
  status: string | null;
  startedAt: string | null;
  label?: string;
}) {
  const text =
    age === null
      ? status
        ? `${label} last run ${status}`
        : `${label} never synced`
      : `${label} synced ${age < 1 ? "<1" : Math.round(age)}h ago`;

  return (
    <div
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium ${
        stale ? "bg-warning/15 text-warning" : "bg-positive/15 text-positive"
      }`}
      title={startedAt ? `Last run started ${startedAt}` : undefined}
    >
      {stale ? <AlertTriangle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
      {stale ? `Stale — ${text}` : text}
    </div>
  );
}
