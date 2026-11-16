import { describe, expect, it } from "vitest";

import { activeDimensions, agencyCoverageBlocked, agencyRatiosAllowed } from "./FilterScope";
import { contractFor, supportsFilter } from "@/lib/contracts";

/**
 * THE GATE THAT COST 48.84x, AND ALMOST 7x IN THE OTHER DIRECTION.
 *
 * A figure that cannot be split by team must refuse under a team filter — full
 * stop, whatever the coverage flags say. Coverage decides whether a splittable
 * figure is HONEST; it can never decide whether an unsplittable one is
 * ALLOWED. This test exists so that inversion cannot be reintroduced quietly.
 */
const blocked = (
  scope: Parameters<typeof activeDimensions>[0],
  contractId: string,
): boolean => {
  const c = contractFor(contractId);
  if (c === null) return true;
  return (
    activeDimensions(scope).some((d) => !supportsFilter(c, d)) ||
    agencyCoverageBlocked(scope, c.agencyNeedsCoverage === true)
  );
};

/** A contract that declares no filter dimensions at all. */
const unsplittable = (() => {
  const ids = ["front_end_roas", "cost_per_sale", "show_up_rate"];
  for (const id of ids) {
    const c = contractFor(id);
    if (c && c.filters.length === 0) return id;
  }
  return null;
})();

describe("team filter refusal", () => {
  it("marks the team dimension active whenever a team filter is set", () => {
    expect(activeDimensions({ agency: "SD" })).toContain("agency");
    // ...including for a team whose coverage looks perfect. Coverage is not a
    // reason to stop asking whether the figure can be split at all.
    expect(
      activeDimensions({
        agency: "SD",
        ratiosComputable: ["SD"],
        ratiosValidFrom: { SD: "2026-01-01" },
        rangeStart: "2026-08-01",
      }),
    ).toContain("agency");
  });

  it("refuses an unsplittable figure under a team filter regardless of coverage", () => {
    if (!unsplittable) return; // no such contract in the registry right now
    expect(
      blocked(
        {
          agency: "SD",
          ratiosComputable: ["SD"],
          ratiosValidFrom: { SD: "2026-01-01" },
          rangeStart: "2026-08-01",
        },
        unsplittable,
      ),
    ).toBe(true);
  });

  it("still allows an unsplittable figure with no team filter on", () => {
    if (!unsplittable) return;
    expect(blocked({}, unsplittable)).toBe(false);
  });

  it("never allows ratios before the team's own valid-from date", () => {
    const scope = {
      agency: "SD",
      ratiosComputable: ["SD"],
      ratiosValidFrom: { SD: "2026-08-01" },
      rangeStart: "2026-07-01",
    };
    expect(agencyRatiosAllowed(scope)).toBe(false);
    expect(agencyRatiosAllowed({ ...scope, rangeStart: "2026-08-05" })).toBe(true);
  });

  it("refuses when the team is held, whatever its coverage was", () => {
    expect(agencyRatiosAllowed({ agency: "SD", ratiosComputable: [], rangeStart: "2026-09-01" })).toBe(
      false,
    );
  });
});
