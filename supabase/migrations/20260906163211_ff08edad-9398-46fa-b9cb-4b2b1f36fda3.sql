-- lovable-cron-fallback-reviewed: 288 runs/day; one-off historical import, each run is a bounded resumable batch guarded by a lease, unscheduled once complete.
select cron.unschedule('ghl-backfill');
select cron.schedule(
  'ghl-backfill',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/cron/ghl-backfill',
    body := '{"budgetMs":240000,"maxMonths":2}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

update public.cron_manifest
set schedule = '*/5 * * * *',
    body = '{"budgetMs":240000,"maxMonths":2}'::jsonb,
    updated_at = now()
where jobname = 'ghl-backfill';