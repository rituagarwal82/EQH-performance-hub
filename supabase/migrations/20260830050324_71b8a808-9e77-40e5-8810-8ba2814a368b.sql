select cron.unschedule(jobid) from cron.job where jobname in
  ('sync-meta-daily','sync-zoom-daily','sync-ledger-daily','sync-tagmango-payments-daily');

select cron.schedule('sync-meta-daily', '30 3 * * *', $job$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c.lovable.app/api/public/cron/sync-meta',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 900000);
$job$);

select cron.schedule('sync-zoom-daily', '10 4 * * *', $job$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c.lovable.app/api/public/cron/sync-zoom',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 900000);
$job$);

select cron.schedule('sync-ledger-daily', '40 4 * * *', $job$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c.lovable.app/api/public/sync-ledger',
    body := '{"refresh":true}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 900000);
$job$);

select cron.schedule('sync-tagmango-payments-daily', '20 5 * * *', $job$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c.lovable.app/api/public/sync-tagmango-payments',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 900000);
$job$);

create table if not exists public.sync_source_config (
  source text primary key,
  label text not null,
  cadence_hours numeric not null default 24,
  is_critical boolean not null default true,
  note text
);

grant select on public.sync_source_config to authenticated;
grant all on public.sync_source_config to service_role;
alter table public.sync_source_config enable row level security;
do $$ begin
  create policy "Authenticated can read sync_source_config"
    on public.sync_source_config for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "Service role manages sync_source_config"
    on public.sync_source_config for all to service_role using (true) with check (true);
exception when duplicate_object then null; end $$;

insert into public.sync_source_config (source, label, cadence_hours, is_critical, note) values
  ('cron', 'Meta spend (account/campaign/ad set)', 24, true, 'Daily cron, rolling 8-day re-pull'),
  ('cron-ads', 'Meta spend (ad level)', 24, true, 'Runs inside the same daily Meta cron'),
  ('zoom-cron', 'Zoom webinars', 24, true, 'Daily cron'),
  ('ledger', 'Collections ledger (Google Sheet)', 24, true, 'Daily, trailing 60 days re-read'),
  ('tagmango-payments', 'TagMango payments', 24, false, 'Entitlement only — not the revenue source of truth')
on conflict (source) do update set
  label = excluded.label, cadence_hours = excluded.cadence_hours,
  is_critical = excluded.is_critical, note = excluded.note;

create or replace view public.sync_health
with (security_invoker = true) as
with last_ok as (
  select source, max(coalesce(finished_at, started_at)) as at
  from public.sync_runs where status = 'success' group by source
), last_any as (
  select source, max(started_at) as at from public.sync_runs group by source
), fails as (
  select r.source, count(*) as n
  from public.sync_runs r
  left join last_ok o on o.source = r.source
  where r.status in ('error','partial','warning')
    and (o.at is null or r.started_at > o.at)
  group by r.source
)
select
  c.source,
  c.label,
  c.cadence_hours,
  c.is_critical,
  c.note,
  o.at as last_success,
  a.at as last_run,
  case when o.at is null then null
       else round((extract(epoch from (now() - o.at)) / 3600.0)::numeric, 1) end as hours_since_success,
  coalesce(f.n, 0)::int as consecutive_failures,
  (select r.error from public.sync_runs r
    where r.source = c.source and r.error is not null
    order by r.started_at desc limit 1) as last_error,
  case
    when o.at is null then 'dead'
    when extract(epoch from (now() - o.at)) / 3600.0 >= c.cadence_hours * 3 then 'dead'
    when extract(epoch from (now() - o.at)) / 3600.0 >= c.cadence_hours * 1.5 then 'late'
    else 'ok'
  end as status
from public.sync_source_config c
left join last_ok o on o.source = c.source
left join last_any a on a.source = c.source
left join fails f on f.source = c.source;

grant select on public.sync_health to authenticated, service_role;

create or replace function public.sync_health_rows()
returns table(source text, label text, cadence_hours numeric, is_critical boolean,
  last_success timestamptz, last_run timestamptz, hours_since_success numeric,
  consecutive_failures int, last_error text, status text)
language sql stable security definer set search_path to 'public' as $$
  select source, label, cadence_hours, is_critical, last_success, last_run,
         hours_since_success, consecutive_failures, last_error, status
  from public.sync_health
  order by case status when 'dead' then 0 when 'late' then 1 else 2 end,
           hours_since_success desc nulls first
$$;

create or replace function public.sync_recent_runs(p_limit integer default 20)
returns table(source text, started_at timestamptz, finished_at timestamptz,
  status text, rows_written integer, error text)
language sql stable security definer set search_path to 'public' as $$
  select source, started_at, finished_at, status, rows_written, error
  from (
    select r.*, row_number() over (partition by r.source order by r.started_at desc) as rn
    from public.sync_runs r
  ) x
  where rn <= greatest(1, least(p_limit, 100))
  order by source, started_at desc
$$;

revoke all on function public.sync_health_rows() from public, anon;
revoke all on function public.sync_recent_runs(integer) from public, anon;
grant execute on function public.sync_health_rows() to authenticated, service_role;
grant execute on function public.sync_recent_runs(integer) to authenticated, service_role;