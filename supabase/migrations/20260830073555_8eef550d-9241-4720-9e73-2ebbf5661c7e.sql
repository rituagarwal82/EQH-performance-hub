select cron.unschedule('sync-ghl-leads-6h') where exists (select 1 from cron.job where jobname = 'sync-ghl-leads-6h');

select cron.schedule(
  'sync-ghl-leads-6h',
  '5 */6 * * *',
  $$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/cron/sync-ghl-leads',
    body := '{"days":3}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);