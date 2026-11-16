-- lovable-cron-fallback-reviewed: 144 runs/day; one-off historical import, each run is a bounded resumable batch; the endpoint returns skipped once status=done and the job is unscheduled after completion.
select cron.schedule(
  'ghl-backfill',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/cron/ghl-backfill',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object('budgetMs', 45000, 'maxMonths', 2),
    timeout_milliseconds := 60000
  );
  $$
);

insert into public.cron_manifest (jobname, schedule, url_path, body, max_gap_hours, active, note)
values (
  'ghl-backfill',
  '*/10 * * * *',
  '/api/public/cron/ghl-backfill',
  jsonb_build_object('budgetMs', 45000, 'maxMonths', 2),
  1,
  true,
  'One-off full-history lead import. Self-terminates when the cursor reaches the current month (status=done); unschedule after that.'
)
on conflict (jobname) do update set
  schedule = excluded.schedule,
  url_path = excluded.url_path,
  body = excluded.body,
  max_gap_hours = excluded.max_gap_hours,
  active = true,
  note = excluded.note,
  updated_at = now();