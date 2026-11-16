select cron.unschedule('sync-zoom-daily');
select cron.schedule('sync-zoom-4x', '0 11,13,16,23 * * *', $$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/cron/sync-zoom',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 900000);
$$);
update public.feed_config set cadence_hours = 6 where feed = 'zoom';
update public.sync_source_config set cadence_hours = 6 where source like 'zoom%';