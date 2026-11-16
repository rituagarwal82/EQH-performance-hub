import { createServerFn } from "@tanstack/react-start";
import { safeMessage } from "./safe-error";

export type GoldenLine = {
  golden_id: string;
  metric_id: string;
  window_start: string;
  window_end: string;
  expected_value: number;
  tolerance_abs: number | null;
  tolerance_pct: number | null;
  verified_by: string;
  note: string | null;
  contract_version: number;
  last_run_at: string | null;
  computed_value: number | null;
  delta: number | null;
  pass: boolean | null;
  error: string | null;
};

export type GoldenStatus = {
  configured: boolean;
  goldens: GoldenLine[];
  contracts: { metric_id: string; version: number; basis: string | null; source_function: string | null }[];
  lastDeploy: {
    deploy_ref: string;
    verified_at: string | null;
    verify_status: string | null;
    goldens_pass: number | null;
    goldens_fail: number | null;
    invariants_diverged: number | null;
  } | null;
  error: string | null;
};

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * The harness read-out. Goldens are verified historical figures re-derived from
 * live code; a failing one means the number the owner signed off on no longer
 * reproduces, which is a louder fact than any single day's divergence.
 */
export const getGoldenStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<GoldenStatus> => {
    const { getPg, pgSelect } = await import("./pg.server");
    const empty: GoldenStatus = {
      configured: false,
      goldens: [],
      contracts: [],
      lastDeploy: null,
      error: null,
    };
    const pg = getPg();
    if (!pg) return empty;

    try {
      const [tests, runs, contracts, deploys] = await Promise.all([
        pgSelect<
          {
            golden_id: string;
            metric_id: string;
            window_start: string;
            window_end: string;
            expected_value: number | string;
            tolerance_abs: number | string | null;
            tolerance_pct: number | string | null;
            verified_by: string;
            note: string | null;
            contract_version: number;
          }[]
        >(pg, "/golden_tests?select=*&order=golden_id.asc"),
        pgSelect<
          {
            golden_id: string;
            run_at: string;
            computed_value: number | string | null;
            delta: number | string | null;
            pass: boolean | null;
            error: string | null;
          }[]
        >(
          pg,
          "/golden_runs?select=golden_id,run_at,computed_value,delta,pass,error&order=run_at.desc&limit=400",
        ),
        pgSelect<
          { metric_id: string; version: number; basis: string | null; source_function: string | null }[]
        >(
          pg,
          "/metric_contracts?select=metric_id,version,basis,source_function&is_current=is.true&order=metric_id.asc",
        ),
        pgSelect<GoldenStatus["lastDeploy"][]>(
          pg,
          "/deploys?select=deploy_ref,verified_at,verify_status,goldens_pass,goldens_fail,invariants_diverged&order=deployed_at.desc&limit=1",
        ),
      ]);

      const latest = new Map<string, (typeof runs)[number]>();
      for (const r of runs ?? []) if (!latest.has(r.golden_id)) latest.set(r.golden_id, r);

      return {
        configured: true,
        goldens: (tests ?? []).map((t) => {
          const r = latest.get(t.golden_id);
          return {
            golden_id: t.golden_id,
            metric_id: t.metric_id,
            window_start: t.window_start,
            window_end: t.window_end,
            expected_value: num(t.expected_value),
            tolerance_abs: t.tolerance_abs === null ? null : num(t.tolerance_abs),
            tolerance_pct: t.tolerance_pct === null ? null : num(t.tolerance_pct),
            verified_by: t.verified_by,
            note: t.note,
            contract_version: t.contract_version,
            last_run_at: r?.run_at ?? null,
            computed_value:
              r?.computed_value === null || r?.computed_value === undefined
                ? null
                : num(r.computed_value),
            delta: r?.delta === null || r?.delta === undefined ? null : num(r.delta),
            pass: r?.pass ?? null,
            error: r?.error ?? null,
          };
        }),
        contracts: contracts ?? [],
        lastDeploy: deploys?.[0] ?? null,
        error: null,
      };
    } catch (e) {
      return { ...empty, configured: true, error: safeMessage(e) };
    }
  },
);
