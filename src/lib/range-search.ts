import type { RangeSearch } from "@/components/RangeBar";
import { DEFAULT_PRESET, RANGE_PRESETS, type RangePreset } from "./date-range";
import { DENSITIES, GRAINS, type Density, type Grain } from "./view-prefs";

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** URL is the source of truth for range, comparison, scope, grain and density. */
export function validateRangeSearch(search: Record<string, unknown>): RangeSearch {
  const raw = String(search["range"] ?? "");
  const range = (RANGE_PRESETS as readonly string[]).includes(raw)
    ? (raw as RangePreset)
    : DEFAULT_PRESET;
  const agency = typeof search["agency"] === "string" && search["agency"] ? search["agency"] : undefined;
  const grainRaw = String(search["grain"] ?? "");
  const viewRaw = String(search["view"] ?? "");
  return {
    range,
    since: isDate(search["since"]) ? search["since"] : undefined,
    until: isDate(search["until"]) ? search["until"] : undefined,
    // Comparison is on by default — a number without its prior period is a rumour.
    compare: search["compare"] === undefined ? true : search["compare"] !== false && search["compare"] !== "false",
    agency,
    grain: (GRAINS as readonly string[]).includes(grainRaw) ? (grainRaw as Grain) : undefined,
    view: (DENSITIES as readonly string[]).includes(viewRaw) ? (viewRaw as Density) : undefined,
  };
}
