
create table if not exists public.feed_config (
  feed text primary key,
  label text not null,
  cadence_hours numeric not null default 24,
  is_blocking boolean not null default false,
  sources text[] not null default '{}'::text[],
  note text
);

grant select on public.feed_config to authenticated;
grant all on public.feed_config to service_role;
alter table public.feed_config enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='feed_config' and policyname='Authenticated can read feed_config') then
    create policy "Authenticated can read feed_config" on public.feed_config for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='feed_config' and policyname='Service role manages feed_config') then
    create policy "Service role manages feed_config" on public.feed_config for all to service_role using (true) with check (true);
  end if;
end $$;

insert into public.feed_config (feed, label, cadence_hours, is_blocking, sources, note) values
  ('meta_ads','Meta Ads spend',24,true,array['cron','cron-ads','manual','backfill'],'Blocking: every spend figure depends on it'),
  ('zoom','Zoom webinars',24,false,array['zoom-cron','zoom-manual','zoom'],'180-day report floor'),
  ('ledger','Collections ledger',24,true,array['ledger','ledger-cron','ledger-manual'],'Blocking: revenue source of truth'),
  ('tm_payments','TagMango payments',24,false,array['tagmango-payments'],'Entitlement only'),
  ('tm_products','TagMango products',168,false,array['tagmango-products'],'Catalogue'),
  ('leads','Lead records (GHL)',24,false,array['ghl-leads','leads'],'Attribution join key')
on conflict (feed) do update set
  label = excluded.label,
  cadence_hours = excluded.cadence_hours,
  is_blocking = excluded.is_blocking,
  sources = excluded.sources,
  note = excluded.note;

-- A run still "running" past twice its cadence is broken, not in progress.
create or replace function public.reap_abandoned_runs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  with cad as (
    select r.id, coalesce(max(f.cadence_hours), 24) as cadence
    from sync_runs r
    left join feed_config f on r.source = any(f.sources)
    where r.status = 'running' and r.finished_at is null
    group by r.id
  )
  update sync_runs r
     set status = 'abandoned',
         finished_at = now(),
         error = coalesce(r.error, 'no completion was ever recorded — marked abandoned after 2x cadence')
    from cad
   where r.id = cad.id
     and r.started_at < now() - (cad.cadence * 2 || ' hours')::interval;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.reap_abandoned_runs() from anon, public;
grant execute on function public.reap_abandoned_runs() to authenticated, service_role;

-- Four-state feed health, driven by run age AND the coverage edge of the facts.
create or replace function public.feed_health_rows()
returns table (
  feed text,
  label text,
  cadence_hours numeric,
  is_blocking boolean,
  last_success timestamptz,
  last_run timestamptz,
  last_run_status text,
  running_since timestamptz,
  hours_since_success numeric,
  coverage_edge date,
  coverage_lag_days numeric,
  consecutive_failures integer,
  last_error text,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.reap_abandoned_runs();

  return query
  with runs as (
    select f.feed,
           max(r.finished_at) filter (where r.status = 'success') as last_success,
           max(r.started_at) as last_run,
           max(r.started_at) filter (where r.status = 'running' and r.finished_at is null) as running_since
      from feed_config f
      left join sync_runs r on r.source = any(f.sources)
     group by f.feed
  ),
  latest as (
    select f.feed,
           (array_agg(r.status order by r.started_at desc))[1] as last_run_status,
           (array_agg(r.error order by r.started_at desc))[1] as last_error
      from feed_config f
      left join sync_runs r on r.source = any(f.sources)
     group by f.feed
  ),
  fails as (
    select f.feed, count(*)::int as consecutive_failures
      from feed_config f
      left join sync_runs r on r.source = any(f.sources)
       and r.started_at > coalesce((select max(x.finished_at) from sync_runs x where x.source = any(f.sources) and x.status='success'), '-infinity'::timestamptz)
       and r.status in ('error','abandoned')
     group by f.feed
  ),
  cov as (
    select f.feed,
           case f.feed
             when 'meta_ads' then (select max(d.date) from daily_metrics d where d.level = 'account')
             when 'zoom' then (select max(z.business_date) from zoom_sessions z)
             when 'ledger' then (select max(l.business_date) from ledger_inflow l)
             when 'tm_payments' then (select max(p.business_date) from tm_payments p)
             when 'tm_products' then (select max(pr.last_synced_at)::date from products pr)
             when 'leads' then (select max(le.business_date) from leads le)
           end as coverage_edge
      from feed_config f
  )
  select f.feed,
         f.label,
         f.cadence_hours,
         f.is_blocking,
         r.last_success,
         r.last_run,
         l.last_run_status,
         r.running_since,
         case when r.last_success is null then null
              else round(extract(epoch from (now() - r.last_success)) / 3600.0, 2) end as hours_since_success,
         c.coverage_edge,
         case when c.coverage_edge is null then null
              else (current_date - c.coverage_edge)::numeric end as coverage_lag_days,
         coalesce(fl.consecutive_failures, 0),
         l.last_error,
         case
           when r.last_success is null then 'broken'
           when r.running_since is not null and r.running_since < now() - (f.cadence_hours * 2 || ' hours')::interval then 'broken'
           when extract(epoch from (now() - r.last_success)) / 3600.0 > f.cadence_hours * 3 then 'broken'
           when c.coverage_edge is null then 'broken'
           when (current_date - c.coverage_edge) > (f.cadence_hours / 24.0) + 3 then 'broken'
           when extract(epoch from (now() - r.last_success)) / 3600.0 > f.cadence_hours * 2 then 'stale'
           when (current_date - c.coverage_edge) > (f.cadence_hours / 24.0) + 1.5 then 'stale'
           when extract(epoch from (now() - r.last_success)) / 3600.0 > f.cadence_hours * 1.25 then 'late'
           else 'live'
         end as status
    from feed_config f
    join runs r on r.feed = f.feed
    join latest l on l.feed = f.feed
    left join fails fl on fl.feed = f.feed
    left join cov c on c.feed = f.feed
   order by f.is_blocking desc, f.feed;
end $$;

revoke execute on function public.feed_health_rows() from anon, public;
grant execute on function public.feed_health_rows() to authenticated, service_role;

-- Day-by-day collection presence, so a range can be clipped to what exists.
create or replace function public.daily_coverage(p_start date, p_end date)
returns table (date date, meta_rows bigint, ledger_rows bigint, zoom_rows bigint, leads_rows bigint)
language sql
stable
security definer
set search_path = public
as $$
  select d::date as date,
         (select count(*) from daily_metrics m where m.level='account' and m.date = d::date) as meta_rows,
         (select count(*) from ledger_inflow l where l.business_date = d::date) as ledger_rows,
         (select count(*) from zoom_sessions z where z.business_date = d::date) as zoom_rows,
         (select count(*) from leads le where le.business_date = d::date) as leads_rows
    from generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') d
$$;

revoke execute on function public.daily_coverage(date, date) from anon, public;
grant execute on function public.daily_coverage(date, date) to authenticated, service_role;
