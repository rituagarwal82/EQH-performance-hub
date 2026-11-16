import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CRON_ROUTES } from "./cron-routes";

const ROOT = join(process.cwd(), "src/routes/api/public");

function endpointFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const child of readdirSync(join(ROOT, entry.name))) {
        if (child.endsWith(".ts")) out.push(`${entry.name}/${child.replace(/\.ts$/, "")}`);
      }
    } else if (entry.name.endsWith(".ts")) {
      out.push(entry.name.replace(/\.ts$/, ""));
    }
  }
  return out.sort();
}

describe("job endpoints", () => {
  it("declares every endpoint with a schedule or an explicit on-demand note", () => {
    const declared = new Set(CRON_ROUTES.map((r) => r.file));
    const undeclared = endpointFiles().filter((f) => !declared.has(f));
    expect(undeclared, "add these to CRON_ROUTES and to cron_manifest").toEqual([]);
  });

  it("has no declaration pointing at a route that no longer exists", () => {
    const present = new Set(endpointFiles());
    expect(CRON_ROUTES.filter((r) => !present.has(r.file)).map((r) => r.file)).toEqual([]);
  });

  it("gives every declaration a schedule or 'on demand'", () => {
    for (const r of CRON_ROUTES) {
      expect(r.schedule.length, r.file).toBeGreaterThan(0);
      if (r.schedule === "on demand") expect(r.jobname, r.file).toBeTruthy();
    }
  });
});
