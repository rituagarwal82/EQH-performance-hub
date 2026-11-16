-- V1 (part 2): 'success_no_yield' is only a real concern when the row count was
-- judged short ('low' / 'zero_anomalous'). When it was simply unjudgeable
-- ('unknown' — no baseline yet), the run finished cleanly and must count as a
-- success. 242 of the 245 such runs are 'unknown'.

-- Stop labelling an unjudgeable run as a non-yielding one in the first place.
CREATE OR REPLACE FUNCTION public.judge_yield(p_run_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare j record; r record;
begin
  select * into r from sync_runs where id = p_run_id;
  if not found then return 'no such run'; end if;
  select * into j from public.judge_yield_of(r.source, coalesce(r.rows_written,0), r.id, r.started_at);
  update sync_runs set expected_rows = j.expected, yield_verdict = j.verdict, yield_note = j.note,
    status = case when status in ('success','ok') and j.verdict in ('low','zero_anomalous')
                  then 'success_no_yield' else status end
   where id = p_run_id;
  return j.verdict;
end $function$;

-- Correct the runs already mislabelled by the old rule.
UPDATE sync_runs SET status = 'success'
 WHERE status = 'success_no_yield'
   AND coalesce(yield_verdict, 'unknown') NOT IN ('low', 'zero_anomalous');

-- Older per-source health view: same list, same meaning.
CREATE OR REPLACE VIEW public.sync_health WITH (security_invoker = on) AS
 WITH last_ok AS (
         SELECT sync_runs.source,
            max(COALESCE(sync_runs.finished_at, sync_runs.started_at)) AS at
           FROM sync_runs
          WHERE sync_runs.status = ANY (ARRAY['success'::text, 'ok'::text, 'partial'::text, 'warning'::text])
          GROUP BY sync_runs.source
        ), last_any AS (
         SELECT sync_runs.source,
            max(sync_runs.started_at) AS at
           FROM sync_runs
          GROUP BY sync_runs.source
        ), fails AS (
         SELECT r.source,
            count(*) AS n
           FROM sync_runs r
             LEFT JOIN last_ok o_1 ON o_1.source = r.source
          WHERE (r.status = ANY (ARRAY['error'::text, 'success_no_yield'::text])) AND (o_1.at IS NULL OR r.started_at > o_1.at)
          GROUP BY r.source
        )
 SELECT c.source,
    c.label,
    c.cadence_hours,
    c.is_critical,
    c.note,
    o.at AS last_success,
    a.at AS last_run,
        CASE
            WHEN o.at IS NULL THEN NULL::numeric
            ELSE round(EXTRACT(epoch FROM now() - o.at) / 3600.0, 1)
        END AS hours_since_success,
    COALESCE(f.n, 0::bigint)::integer AS consecutive_failures,
    ( SELECT r.error
           FROM sync_runs r
          WHERE r.source = c.source AND r.error IS NOT NULL
          ORDER BY r.started_at DESC
         LIMIT 1) AS last_error,
        CASE
            WHEN o.at IS NULL THEN 'dead'::text
            WHEN (EXTRACT(epoch FROM now() - o.at) / 3600.0) >= (c.cadence_hours * 3::numeric) THEN 'dead'::text
            WHEN (EXTRACT(epoch FROM now() - o.at) / 3600.0) >= (c.cadence_hours * 1.5) THEN 'late'::text
            ELSE 'ok'::text
        END AS status
   FROM sync_source_config c
     LEFT JOIN last_ok o ON o.source = c.source
     LEFT JOIN last_any a ON a.source = c.source
     LEFT JOIN fails f ON f.source = c.source;

-- feed_health_rows: a 'success_no_yield' row counts as a success only when the
-- shortfall was not actually established.
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
    select f.feed, count(*)::int as consecutive_failures
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
           when f.forced_stale_reason is not null then 'stale'
           when extract(epoch from (now() - r.last_success)) / 3600.0 > f.cadence_hours * 2 then 'stale'
           when (current_date - c.coverage_edge) > (f.cadence_hours / 24.0) + 1.5 then 'stale'
           when extract(epoch from (now() - r.last_success)) / 3600.0 > f.cadence_hours * 1.25 then 'late'
           else 'live'
         end,
         l.rows_last_run,
         case when f.forced_stale_reason is not null then f.forced_stale_reason
              when f.feed = 'meta_ads' and v_days is not null and v_days <= 30
              then 'The Meta connection expires in ' || v_days || ' day' || case when v_days = 1 then '' else 's' end
                   || ' (' || to_char(v_expiry, 'DD Mon YYYY') || '). Ad spend stops arriving after that.'
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
   order by f.is_blocking desc, f.label;
end;
$function$;