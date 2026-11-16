INSERT INTO public.app_settings (key, value, description)
VALUES ('meta_token_expires_at', '2026-10-28',
        'Date the Meta access token stops working. There is no refresh flow — renewing is manual and takes about 10 minutes.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.feed_day_strip(p_days integer DEFAULT 30)
RETURNS TABLE(feed text, date date, rows_n bigint, state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH d AS (
    SELECT g::date AS date
    FROM generate_series(current_date - (greatest(1, least(p_days, 120)) - 1),
                         current_date, interval '1 day') g
  ), raw AS (
    SELECT 'meta_ads'::text AS feed, d.date,
           (SELECT count(*) FROM daily_metrics m WHERE m.level='account' AND m.date = d.date) AS rows_n
    FROM d
    UNION ALL
    SELECT 'zoom', d.date, (SELECT count(*) FROM zoom_sessions z WHERE z.business_date = d.date) FROM d
    UNION ALL
    SELECT 'ledger', d.date, (SELECT count(*) FROM ledger_inflow l WHERE l.business_date = d.date) FROM d
    UNION ALL
    SELECT 'tm_payments', d.date, (SELECT count(*) FROM tm_payments p WHERE p.business_date = d.date) FROM d
    UNION ALL
    SELECT 'tm_products', d.date, (SELECT count(*) FROM products pr WHERE pr.last_synced_at::date = d.date) FROM d
    UNION ALL
    SELECT 'leads', d.date, (SELECT count(*) FROM leads le WHERE le.business_date = d.date) FROM d
  ), typ AS (
    SELECT r.feed, percentile_cont(0.5) WITHIN GROUP (ORDER BY r.rows_n) AS typical
    FROM raw r WHERE r.rows_n > 0 GROUP BY r.feed
  )
  SELECT raw.feed, raw.date, raw.rows_n,
         CASE WHEN raw.rows_n = 0 THEN 'none'
              WHEN typ.typical IS NOT NULL AND raw.rows_n < typ.typical * 0.5 THEN 'partial'
              ELSE 'full' END
  FROM raw LEFT JOIN typ ON typ.feed = raw.feed
  ORDER BY raw.feed, raw.date
$$;

REVOKE EXECUTE ON FUNCTION public.feed_day_strip(integer) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.feed_day_strip(integer) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.feed_health_rows();

CREATE OR REPLACE FUNCTION public.feed_health_rows()
 RETURNS TABLE(feed text, label text, cadence_hours numeric, is_blocking boolean,
   last_success timestamp with time zone, last_run timestamp with time zone,
   last_run_status text, running_since timestamp with time zone,
   hours_since_success numeric, coverage_edge date, coverage_lag_days numeric,
   consecutive_failures integer, last_error text, status text,
   rows_last_run integer,
   warning text, warning_level text, expires_at date, days_to_expiry integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  v_expiry date;
  v_days integer;
begin
  perform public.reap_abandoned_runs();

  select nullif(btrim(s.value), '')::date into v_expiry
    from app_settings s where s.key = 'meta_token_expires_at';
  v_days := case when v_expiry is null then null else (v_expiry - current_date) end;

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
           (array_agg(r.error order by r.started_at desc))[1] as last_error,
           (array_agg(r.rows_written order by r.started_at desc))[1] as rows_last_run
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
              else round(extract(epoch from (now() - r.last_success)) / 3600.0, 2) end,
         c.coverage_edge,
         case when c.coverage_edge is null then null
              else (current_date - c.coverage_edge)::numeric end,
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
         end,
         l.rows_last_run,
         case when f.feed = 'meta_ads' and v_days is not null and v_days <= 30
              then 'The Meta connection expires in ' || v_days || ' day' || case when v_days = 1 then '' else 's' end
                   || '. Renewing takes 10 minutes; losing it silently costs days of data.'
              end,
         case when f.feed = 'meta_ads' and v_days is not null and v_days <= 7 then 'critical'
              when f.feed = 'meta_ads' and v_days is not null and v_days <= 30 then 'warning'
              end,
         case when f.feed = 'meta_ads' then v_expiry end,
         case when f.feed = 'meta_ads' then v_days end
    from feed_config f
    join runs r on r.feed = f.feed
    join latest l on l.feed = f.feed
    left join fails fl on fl.feed = f.feed
    left join cov c on c.feed = f.feed
   order by f.is_blocking desc, f.feed;
end $function$;

REVOKE EXECUTE ON FUNCTION public.feed_health_rows() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.feed_health_rows() TO authenticated, service_role;
