select cron.unschedule('rebuild-baselines-daily') where exists (select 1 from cron.job where jobname = 'rebuild-baselines-daily');

select cron.schedule(
  'rebuild-baselines-daily',
  '40 5 * * *',
  $$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/cron/rebuild-baselines',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 300000);
  $$
);