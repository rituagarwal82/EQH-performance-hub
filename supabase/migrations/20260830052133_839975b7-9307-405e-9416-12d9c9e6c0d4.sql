-- Production has no published build, so every scheduled POST 404s. Point the
-- schedules at the always-live preview address until the app is published.
select cron.alter_job((select jobid from cron.job where jobname='sync-meta-daily'), command := $$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/cron/sync-meta',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 900000);
$$);

select cron.alter_job((select jobid from cron.job where jobname='sync-zoom-daily'), command := $$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/cron/sync-zoom',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 900000);
$$);

select cron.alter_job((select jobid from cron.job where jobname='sync-ledger-daily'), command := $$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/sync-ledger',
    body := '{"refresh":true}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 900000);
$$);

select cron.alter_job((select jobid from cron.job where jobname='sync-tagmango-payments-daily'), command := $$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/sync-tagmango-payments',
    body := '{"passes":6}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 900000);
$$);