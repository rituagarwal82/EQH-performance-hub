-- 1. Account role: lead-gen vs retargeting/brand.
ALTER TABLE public.ad_accounts
  ADD COLUMN IF NOT EXISTS account_role text NOT NULL DEFAULT 'lead_gen';

ALTER TABLE public.ad_accounts
  DROP CONSTRAINT IF EXISTS ad_accounts_account_role_chk;
ALTER TABLE public.ad_accounts
  ADD CONSTRAINT ad_accounts_account_role_chk
  CHECK (account_role IN ('lead_gen','retargeting_brand'));

UPDATE public.ad_accounts
   SET account_role = 'retargeting_brand'
 WHERE account_id = '699110549552181';

-- 2. Rollup carries the role so the screens can group by it.
DROP FUNCTION IF EXISTS public.account_month_rollup(date, date);

CREATE FUNCTION public.account_month_rollup(p_start date, p_end date)
RETURNS TABLE(account_id text, name text, agency_code text, is_active boolean,
  lead_tracking_status text, account_role text, spend numeric, leads bigint,
  impressions bigint, landing_page_views bigint, purchases bigint, link_clicks bigint,
  days_with_data bigint, days_missing_leads bigint, has_data boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    a.account_id,
    a.name,
    a.agency_code,
    a.is_active,
    a.lead_tracking_status,
    a.account_role,
    COALESCE(SUM(m.spend), 0)::numeric,
    SUM(m.leads)::bigint,
    SUM(m.impressions)::bigint,
    SUM(m.landing_page_views)::bigint,
    SUM(m.purchases)::bigint,
    SUM(m.link_clicks)::bigint,
    COUNT(m.id)::bigint,
    COUNT(m.id) FILTER (WHERE m.leads IS NULL)::bigint,
    COUNT(m.id) > 0
  FROM public.ad_accounts a
  LEFT JOIN public.daily_metrics m
    ON m.account_id = a.account_id
   AND m.level = 'account'
   AND m.date >= p_start
   AND m.date <= p_end
  GROUP BY a.account_id, a.name, a.agency_code, a.is_active, a.lead_tracking_status, a.account_role
  ORDER BY COALESCE(SUM(m.spend), 0) DESC, a.name ASC
$function$;

-- 3. Feed health: the recordings feed is judged against the cadence its files
--    ACTUALLY arrive at (trailing 4 weeks), not an assumed daily cadence, and
--    only calls "broken" once a whole expected cycle has been missed.
CREATE OR REPLACE FUNCTION public.feed_health_rows()
 RETURNS TABLE(feed text, label text, cadence_hours numeric, is_blocking boolean, last_success timestamp with time zone, last_run timestamp with time zone, last_run_status text, running_since timestamp with time zone, hours_since_success numeric, coverage_edge date, coverage_lag_days numeric, consecutive_failures integer, last_error text, status text, rows_last_run integer, warning text, warning_level text, expires_at date, days_to_expiry integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
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
  with judged as (
    select r.*,
           (r.status in ('success','ok','partial','warning')
             or (r.status = 'success_no_yield'
                 and coalesce(r.yield_verdict,'unknown') not in ('low','zero_anomalous'))) as is_ok
      from sync_runs r
  ),
  runs as (
    select f.feed,
           max(r.finished_at) filter (where r.is_ok) as last_success,
           max(r.started_at) as last_run,
           max(r.started_at) filter (where r.status = 'running' and r.finished_at is null) as running_since
      from feed_config f
      left join judged r on r.source = any(f.sources)
     group by f.feed
  ),
  latest as (
    select f.feed,
           (array_agg(r.status order by r.started_at desc))[1] as last_run_status,
           (array_agg(r.error order by r.started_at desc))[1] as last_error,
           (array_agg(r.rows_written order by r.started_at desc))[1] as rows_last_run
      from feed_config f
      left join judged r on r.source = any(f.sources)
     group by f.feed
  ),
  fails as (
    select f.feed, count(r.id)::int as consecutive_failures
      from feed_config f
      left join judged r on r.source = any(f.sources)
       and r.started_at > coalesce((select max(x.finished_at) from judged x where x.source = any(f.sources) and x.is_ok), '-infinity'::timestamptz)
       and not r.is_ok
       and r.status <> 'running'
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
             when 'proof' then (select max(rc.checked_at)::date from reconciliations rc)
             when 'recordings' then (select max(coalesce(zr.recorded_at, zr.created_at))::date from zoom_recordings zr)
           end as coverage_edge
      from feed_config f
  ),
  -- Observed arrival cadence, in days, from the trailing 4 weeks of real
  -- arrivals. Recordings dropped to one recorded session a week on purpose;
  -- a daily expectation turned that deliberate change into a false alarm.
  obs as (
    select f.feed,
           case f.feed when 'recordings' then (
             select percentile_cont(0.5) within group (order by g.gap)
               from (
                 select (d.day - lag(d.day) over (order by d.day))::numeric as gap
                   from (
                     select distinct coalesce(zr.recorded_at, zr.created_at)::date as day
                       from zoom_recordings zr
                      where coalesce(zr.recorded_at, zr.created_at) >= now() - interval '28 days'
                   ) d
               ) g
              where g.gap is not null
           ) end as obs_days
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
           when (current_date - c.coverage_edge) >
                coalesce(o.obs_days * 2, greatest(f.cadence_hours / 24.0, 1) + 3) then 'broken'
           when f.forced_stale_reason is not null then 'stale'
           when extract(epoch from (now() - r.last_success)) / 3600.0 > f.cadence_hours * 2 then 'stale'
           when (current_date - c.coverage_edge) >
                coalesce(o.obs_days * 1.25, greatest(f.cadence_hours / 24.0, 1) + 1.5) then 'stale'
           when extract(epoch from (now() - r.last_success)) / 3600.0 > f.cadence_hours * 1.25 then 'late'
           else 'live'
         end,
         l.rows_last_run,
         case when f.forced_stale_reason is not null then f.forced_stale_reason
              when f.feed = 'meta_ads' and v_days is not null and v_days <= 30
              then 'The Meta connection expires in ' || v_days || ' day' || case when v_days = 1 then '' else 's' end
                   || ' (' || to_char(v_expiry, 'DD Mon YYYY') || '). Ad spend stops arriving after that.'
              when f.feed = 'recordings' and o.obs_days is not null and o.obs_days >= 3
              then 'Recordings now arrive about every ' || round(o.obs_days)::text
                   || ' days (one recorded session a week). Freshness is judged against that cadence.'
         end,
         case when f.forced_stale_reason is not null then 'stale'
              when f.feed = 'meta_ads' and v_days is not null and v_days <= 7 then 'critical'
              when f.feed = 'meta_ads' and v_days is not null and v_days <= 30 then 'warning'
         end,
         case when f.feed = 'meta_ads' then v_expiry end,
         case when f.feed = 'meta_ads' then v_days end
    from feed_config f
    join runs r on r.feed = f.feed
    join latest l on l.feed = f.feed
    left join fails fl on fl.feed = f.feed
    left join cov c on c.feed = f.feed
    left join obs o on o.feed = f.feed
   order by f.is_blocking desc, f.label;
end;
$function$;