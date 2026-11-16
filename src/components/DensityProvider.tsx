import { useRouterState } from "@tanstack/react-router";
import { createContext, useContext, type ReactNode } from "react";

import { DENSITIES, useDensity, type Density } from "@/lib/view-prefs";

/**
 * Brief ⇄ Working, held once for the whole app.
 *
 * Every screen answers one question. Brief shows only what answers it; Working
 * shows everything that was ever visible. The mode is a reading preference, so
 * it lives above the routes — one switch in the shell drives every screen, and
 * a `?view=` in a shared link still wins for that visit.
 */
type DensityCtx = {
  density: Density;
  setDensity: (d: Density) => void;
  brief: boolean;
};

const Ctx = createContext<DensityCtx>({
  density: "brief",
  setDensity: () => {},
  brief: true,
});

export function DensityProvider({ children }: { children: ReactNode }) {
  const fromUrl = useRouterState({
    select: (s) => {
      const v = (s.location.search as Record<string, unknown>)["view"];
      return typeof v === "string" && (DENSITIES as readonly string[]).includes(v)
        ? (v as Density)
        : undefined;
    },
  });
  const value = useDensity(fromUrl);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDensityMode(): DensityCtx {
  return useContext(Ctx);
}
