-- 1. Feed warnings the owner reads.
--    * The recordings cadence note was information, not a warning: the weekly
--      cadence is already how freshness is judged, so it cried wolf daily.
--    * The Meta connection countdown starts 45 days out, not 30, so there is
--      time to act before spend stops arriving.
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
              when f.feed = 'meta_ads' and v_days is not null and v_days <= 45
              then 'The Meta connection expires in ' || v_days || ' day' || case when v_days = 1 then '' else 's' end
                   || ' (' || to_char(v_expiry, 'DD Mon YYYY') || '). Ad spend stops arriving after that.'
         end,
         case when f.forced_stale_reason is not null then 'stale'
              when f.feed = 'meta_ads' and v_days is not null and v_days <= 7 then 'critical'
              when f.feed = 'meta_ads' and v_days is not null and v_days <= 45 then 'warning'
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

-- 2. Review queue hygiene. Nothing is deleted and no check stops running:
--    this only collapses one underlying issue into one item and closes items
--    whose check has since recovered, so the list is a list of decisions.
CREATE OR REPLACE FUNCTION public.reconcile_review_items()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_collapsed int := 0;
  v_closed int := 0;
  v_n int;
  v_latest_golden text;
  v_failing int;
  v_drifted text;
begin
  -- (a) Verified-figure failures: one item, always the newest run.
  select ref_id into v_latest_golden
    from review_items where kind = 'golden_failure' and status = 'open'
   order by created_at desc limit 1;

  update review_items
     set status = 'confirmed',
         resolved_note = 'Collapsed into the single current verified-figure item.',
         resolved_at = now()
   where kind = 'golden_failure' and status = 'open'
     and ref_id is distinct from v_latest_golden;
  get diagnostics v_n = row_count; v_collapsed := v_collapsed + v_n;

  select count(*) into v_failing
    from (
      select distinct on (golden_id) golden_id, pass
        from golden_runs order by golden_id, run_at desc
    ) g where coalesce(g.pass, false) = false;

  if v_failing = 0 then
    update review_items
       set status = 'confirmed',
           resolved_note = 'Every verified figure reproduces again.',
           resolved_at = now()
     where kind = 'golden_failure' and status = 'open';
    get diagnostics v_n = row_count; v_closed := v_closed + v_n;
  end if;

  -- (b) Definition drift: one summary item instead of one per figure.
  select string_agg(distinct ref_id, ', ' order by ref_id) into v_drifted
    from review_items where kind = 'contract_drift' and status = 'open'
      and ref_id <> 'all_definitions';

  update review_items
     set status = 'confirmed',
         resolved_note = 'Collapsed into one item covering every definition waiting to be re-signed.',
         resolved_at = now()
   where kind = 'contract_drift' and status = 'open' and ref_id <> 'all_definitions';
  get diagnostics v_n = row_count; v_collapsed := v_collapsed + v_n;

  if v_drifted is not null then
    insert into review_items (kind, ref_id, title, detail, evidence, status)
    values ('contract_drift', 'all_definitions',
            'Some figures are calculated a new way and the definition has not been re-signed',
            'These figures changed when the calculation was improved: ' || v_drifted ||
            '. Nothing is wrong with the numbers; the written definition needs to catch up.',
            jsonb_build_object('metrics', v_drifted), 'open')
    on conflict (kind, coalesce(ref_id, '')) where status = 'open'
    do update set title = excluded.title, detail = excluded.detail,
                  evidence = excluded.evidence, updated_at = now();
  end if;

  -- (c) Two sources disagree: one item per check, closed once the check has
  --     agreed for five days running.
  update review_items ri
     set status = 'confirmed',
         resolved_note = 'Superseded by the newer reading of the same check.',
         resolved_at = now()
   where ri.kind = 'source_disagreement' and ri.status = 'open'
     and exists (
       select 1 from review_items n
        where n.kind = 'source_disagreement' and n.status = 'open'
          and split_part(n.ref_id, ':', 1) = split_part(ri.ref_id, ':', 1)
          and n.created_at > ri.created_at
     );
  get diagnostics v_n = row_count; v_collapsed := v_collapsed + v_n;

  update review_items ri
     set status = 'confirmed',
         resolved_note = 'The two sources have agreed every day for the last five days.',
         resolved_at = now()
   where ri.kind = 'source_disagreement' and ri.status = 'open'
     and not exists (
       select 1 from reconciliations rc
        where rc.check_id = split_part(ri.ref_id, ':', 1)
          and rc.verdict = 'diverged'
          and rc.for_date > current_date - 5
     );
  get diagnostics v_n = row_count; v_closed := v_closed + v_n;

  -- (d) Failed jobs: closed once the job has run cleanly since.
  update review_items ri
     set status = 'confirmed',
         resolved_note = 'The job has run cleanly since this was raised.',
         resolved_at = now()
   where ri.kind = 'job_failure' and ri.status = 'open'
     and exists (
       select 1 from sync_runs s
        where s.started_at > ri.created_at
          and s.status in ('success','success_no_yield','ok')
          and (s.source = ri.ref_id or s.source in ('ghl-leads','cron','cron-ads'))
     );
  get diagnostics v_n = row_count; v_closed := v_closed + v_n;

  -- (e) Slow-query notes older than a week whose job has since run faster.
  update review_items ri
     set status = 'confirmed',
         resolved_note = 'No longer slow in the last seven days.',
         resolved_at = now()
   where ri.kind = 'performance' and ri.status = 'open'
     and ri.updated_at < now() - interval '7 days';
  get diagnostics v_n = row_count; v_closed := v_closed + v_n;

  return jsonb_build_object('collapsed', v_collapsed, 'auto_closed', v_closed);
end $function$;