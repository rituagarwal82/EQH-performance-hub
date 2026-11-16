/**
 * THE SAFETY NET, READ ON DEMAND.
 *
 * The point of this layer is that it does NOT depend on the scheduler. If the
 * scheduler itself stops firing, the nightly check that would have noticed
 * stops with it — so the same rules are evaluated live, on every page load of
 * the owner's screen and on every call to this function.
 */

import { createServerFn } from "@tanstack/react-start";

import { safeMessage } from "./safe-error";

export type JobWatch = {
  jobname: string;
  plain_label: string;
  schedule: string;
  cadence_hours: number;
  last_start: string | null;
  status: "on_time" | "missed" | "never_ran" | "not_scheduled" | "not_due_yet";
  sentence: string;
  consequence: string;
};

export type FeedRecency = {
  feed: string;
  label: string;
  is_blocking: boolean;
  coverage_edge: string | null;
  lag_days: number | null;
  allowed_lag_days: number | null;
  stalled: boolean;
  sentence: string;
};

export type CredentialAlert = {
  key: string;
  label: string;
  expires_at: string | null;
  days_left: number | null;
  level: "none" | "warning" | "critical";
  sentence: string;
};

export type RetrySummary = {
  source: string;
  step: string;
  retries: number;
  last_at: string;
  last_reason: string | null;
};

export type SafetyNet = {
  configured: boolean;
  jobs: JobWatch[];
  feeds: FeedRecency[];
  credentials: CredentialAlert[];
  retries: RetrySummary[];
  selfTest: { checked_at?: string; ok?: boolean; problems?: string[] } | null;
  error: string | null;
};

const EMPTY: SafetyNet = {
  configured: false,
  jobs: [],
  feeds: [],
  credentials: [],
  retries: [],
  selfTest: null,
  error: null,
};

export const getSafetyNet = createServerFn({ method: "GET" }).handler(
  async (): Promise<SafetyNet> => {
    const { getPg, pgRpc, pgSelect } = await import("./pg.server");
    const pg = getPg();
    if (!pg) return EMPTY;

    try {
      const [jobs, feeds, credentials, retries, setting] = await Promise.all([
        pgRpc<JobWatch[]>(pg, "job_watch_rows", {}),
        pgRpc<FeedRecency[]>(pg, "feed_recency_rows", {}),
        pgRpc<CredentialAlert[]>(pg, "credential_alert_rows", {}),
        pgRpc<RetrySummary[]>(pg, "retry_summary_rows", { p_days: 7 }).catch(() => []),
        pgSelect<{ value: string | null }[]>(
          pg,
          "/app_settings?select=value&key=eq.safety_net_selftest",
        ).catch(() => []),
      ]);

      let selfTest: SafetyNet["selfTest"] = null;
      const raw = setting?.[0]?.value;
      if (raw) {
        try {
          selfTest = JSON.parse(raw) as SafetyNet["selfTest"];
        } catch {
          selfTest = null;
        }
      }

      return {
        configured: true,
        jobs: jobs ?? [],
        feeds: feeds ?? [],
        credentials: credentials ?? [],
        retries: retries ?? [],
        selfTest,
        error: null,
      };
    } catch (e) {
      return { ...EMPTY, configured: true, error: safeMessage(e) };
    }
  },
);
