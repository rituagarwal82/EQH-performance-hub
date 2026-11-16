create or replace function public.feed_health_rows()
 returns table(feed text, label text, cadence_hours numeric, is_blocking boolean, last_success timestamp with time zone, last_run timestamp with time zone, last_run_status text, running_since timestamp with time zone, hours_since_success numeric, coverage_edge date, coverage_lag_days numeric, consecutive_failures integer, last_error text, status text)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  perform public.reap_abandoned_runs();

  return query
  with runs as (
    select f.feed,
           max(r.finished_at) filter (where r.status in ('success','ok','partial')) as last_success,
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
       and r.started_at > coalesce((select max(x.finished_at) from sync_runs x where x.source = any(f.sources) and x.status in ('success','ok','partial')), '-infinity'::timestamptz)
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
end $function$;

revoke execute on function public.feed_health_rows() from anon, public;
grant execute on function public.feed_health_rows() to authenticated, service_role;