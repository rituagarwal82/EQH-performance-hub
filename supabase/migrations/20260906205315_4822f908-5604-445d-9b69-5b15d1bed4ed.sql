select cron.schedule(
  'capture-recordings-hourly',
  '25 * * * *',
  $$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/cron/capture-recordings',
    body := '{"oldestFirst":true}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 600000);
  $$
);

insert into public.cron_manifest (jobname, schedule, url_path, body, max_gap_hours, active, note)
values ('capture-recordings-hourly', '25 * * * *', '/api/public/cron/capture-recordings',
        '{"oldestFirst":true}'::jsonb, 3, true,
        'Hourly Zoom cloud-recording capture; oldest sessions first so expiring recordings are saved before newer ones.')
on conflict (jobname) do update
  set schedule = excluded.schedule,
      url_path = excluded.url_path,
      body = excluded.body,
      max_gap_hours = excluded.max_gap_hours,
      active = true,
      note = excluded.note,
      updated_at = now();