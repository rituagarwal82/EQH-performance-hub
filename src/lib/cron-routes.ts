/**
 * THE RULE: every HTTP job endpoint is declared here, and every declaration
 * says either when it runs or that it only runs on demand.
 *
 * Two endpoints once existed with no schedule and no manifest row, so the job
 * monitor could not notice that they had never run. A checked-in list plus the
 * test beside it makes that failure impossible to repeat: adding a route file
 * without declaring it fails the test, and the manifest job names below are
 * what the monitor watches.
 */

export type CronRouteDecl = {
  /** Path under src/routes/api/public, without the .ts extension. */
  file: string;
  /** Job name in cron_manifest / cron.job, or null for on-demand endpoints. */
  jobname: string | null;
  /** Cron expression, or "on demand". */
  schedule: string;
};

export const CRON_ROUTES: CronRouteDecl[] = [
  { file: "cron/agency-daily", jobname: "sabhi-daily-email", schedule: "10 13 * * *" },
  { file: "cron/agency-weekly", jobname: "sabhi-weekly-email", schedule: "30 4 * * 3" },
  { file: "cron/capture-recordings", jobname: "capture-recordings-hourly", schedule: "25 * * * *" },
  { file: "cron/daily-email", jobname: "daily-status-email", schedule: "30 12 * * *" },
  { file: "cron/creative-brief", jobname: "creative-brief-fortnightly", schedule: "50 6 * * *" },
  { file: "cron/creative-weekly", jobname: "creative-weekly-monday", schedule: "45 6 * * 1" },
  { file: "cron/discover-accounts", jobname: "discover-accounts-weekly", schedule: "15 2 * * 1" },
  { file: "cron/ghl-backfill", jobname: "ghl-backfill", schedule: "on demand" },
  { file: "cron/rebuild-baselines", jobname: "rebuild-baselines-daily", schedule: "40 5 * * *" },
  {
    file: "cron/refresh-source-precompute",
    jobname: "refresh-source-precompute-daily",
    schedule: "55 4 * * *",
  },
  { file: "cron/run-analyst", jobname: "run-analyst-daily", schedule: "30 6 * * *" },
  { file: "cron/run-goldens", jobname: "run-goldens-nightly", schedule: "20 6 * * *" },
  { file: "cron/run-proof", jobname: "run-proof-daily", schedule: "10 6 * * *" },
  { file: "cron/retry-creatives", jobname: "retry-creatives", schedule: "on demand" },
  { file: "cron/weekly-email", jobname: "weekly-status-email", schedule: "15 7 * * 1" },
  { file: "cron/self-test", jobname: "safety-net-selftest-weekly", schedule: "35 7 * * 1" },
  { file: "cron/sync-creative", jobname: "sync-creative-daily", schedule: "15 4 * * *" },
  { file: "cron/sync-ghl-leads", jobname: "sync-ghl-leads-2h", schedule: "5 */2 * * *" },
  { file: "cron/sync-meta", jobname: "sync-meta-daily", schedule: "30 3 * * *" },
  { file: "cron/sync-zoom", jobname: "sync-zoom-4x", schedule: "0 11,13,16,23 * * *" },
  { file: "cron/tag-scripts", jobname: "tag-scripts-daily", schedule: "20 4 * * *" },
  {
    file: "cron/sync-team-register",
    jobname: "sync-team-register-daily",
    schedule: "45 4 * * *",
  },

  { file: "cron/verify-queue", jobname: "verify-queue-daily", schedule: "0 7 * * *" },
  { file: "cron/zoom-host-backfill", jobname: "zoom-host-backfill", schedule: "on demand" },
  { file: "img", jobname: "email-image-proxy", schedule: "on demand" },
  { file: "unsubscribe", jobname: "email-unsubscribe", schedule: "on demand" },
  { file: "seed-scripts", jobname: "seed-scripts", schedule: "on demand" },
  { file: "sync-ledger", jobname: "sync-ledger-daily", schedule: "40 4 * * *" },
  { file: "sync-ledger", jobname: "sync-ledger-evening", schedule: "30 11 * * *" },
  {
    file: "sync-tagmango-payments",
    jobname: "sync-tagmango-payments-hourly",
    schedule: "20 * * * *",
  },
  {
    file: "sync-tagmango-products",
    jobname: "sync-tagmango-products-weekly",
    schedule: "50 5 * * 1",
  },
];
