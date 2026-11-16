-- lovable-cron-fallback-reviewed: 144 runs/day; one-off historical import, bounded resumable batches, unscheduled once complete.
select cron.unschedule('ghl-backfill');
select cron.schedule(
  'ghl-backfill',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/cron/ghl-backfill',
    body := '{"budgetMs":45000,"maxMonths":2}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 90000
  );
  $$
);