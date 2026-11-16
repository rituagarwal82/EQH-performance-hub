import { useCallback, useEffect, useState } from "react";

/**
 * Presentation preferences only. Nothing here may change a number, a metric
 * state, a freshness treatment or an empty state — Brief shows LESS, never
 * SOFTER. Every value is persisted to localStorage and read only after
 * hydration so the server and first client render stay identical.
 */

export const GRAINS = ["day", "week", "month"] as const;
export type Grain = (typeof GRAINS)[number];
export const GRAIN_LABELS: Record<Grain, string> = { day: "Day", week: "Week", month: "Month" };

export const DENSITIES = ["brief", "working"] as const;
export type Density = (typeof DENSITIES)[number];

export type FigureMode = "chart" | "table";

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private browsing — the preference simply does not persist */
  }
}

function usePersisted<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    const stored = readLocal(key);
    if (stored && (allowed as readonly string[]).includes(stored)) setValue(stored as T);
    // `allowed` is a module-level constant tuple in every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeLocal(key, next);
    },
    [key],
  );
  return [value, set] as const;
}

/**
 * Brief ⇄ Working. URL wins when present so a link carries the reader's mode.
 * Brief is the default: the first layer of every screen answers that screen's
 * one question, and everything else is one tap away.
 */
export function useDensity(fromUrl?: Density | undefined) {
  const [stored, setStored] = usePersisted<Density>("eqh.density", DENSITIES, "brief");
  const density: Density = fromUrl ?? stored;
  return { density, setDensity: setStored, brief: density === "brief" };
}


export function useFigureMode(figureId: string, fallback: FigureMode = "chart") {
  return usePersisted<FigureMode>(`eqh.figure.${figureId}`, ["chart", "table"], fallback);
}

/** Rows a Brief reader sees before the "see all" escape hatch. */
export const BRIEF_ROWS = 5;

export const rowHeightClass = (density: Density) =>
  density === "brief" ? "[&_td]:py-2.5 [&_th]:py-2.5" : "[&_td]:py-1 [&_th]:py-1.5";
