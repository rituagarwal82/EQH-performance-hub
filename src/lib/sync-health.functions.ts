import { createServerFn } from "@tanstack/react-start";

/**
 * Pipeline health. A dead pipeline is normal; a dashboard that hides it is the
 * actual defect. Everything here is read straight from sync_runs — no source
 * reports itself healthy, it is judged by when it last actually succeeded.
 */

export type SyncStatus = "ok" | "late" | "dead";

export type SyncHealthRow = {
  source: string;
  label: string;
  cadence_hours: number | string;
  is_critical: boolean;
  last_success: string | null;
  last_run: string | null;
  hours_since_success: number | string | null;
  consecutive_failures: number;
  last_error: string | null;
  status: SyncStatus;
};

export type SyncRunRecord = {
  source: string;
  started_at: string;
  finished_at: string | null;
  status: string | null;
  rows_written: number | null;
  error: string | null;
  expected_rows?: number | string | null;
  yield_verdict?: string | null;
  yield_note?: string | null;
};

export type SyncHealthData = {
  configured: boolean;
  checkedAt: string;
  sources: SyncHealthRow[];
  runs: SyncRunRecord[];
  error: string | null;
};

export const getSyncHealth = createServerFn({ method: "GET" }).handler(
  async (): Promise<SyncHealthData> => {
    const { getPg, pgRpc } = await import("./pg.server");
    const empty: SyncHealthData = {
      configured: false,
      checkedAt: new Date().toISOString(),
      sources: [],
      runs: [],
      error: null,
    };
    const pg = getPg();
    if (!pg) return empty;
    try {
      const [sources, runs] = await Promise.all([
        pgRpc<SyncHealthRow[]>(pg, "sync_health_rows", {}),
        pgRpc<SyncRunRecord[]>(pg, "sync_recent_runs", { p_limit: 20 }),
      ]);
      return {
        configured: true,
        checkedAt: new Date().toISOString(),
        sources,
        runs,
        error: null,
      };
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : String(error) };
    }
  },
);
