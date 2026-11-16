-- 1. A run that COMPLETED counts as finished, whatever its yield.
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
    -- Owner rule, 19 Sep 2026: a run that ended without an error is FINISHED.
    -- A thin yield is a caution about the data, never a claim that the feed
    -- stopped. Only 'error'/'running' keep a run out of the finished set.
    select r.*,
           (r.status in ('success','ok','partial','warning','success_no_yield')) as is_ok,
           (r.status = 'success_no_yield'
             or coalesce(r.yield_verdict,'') in ('low','zero_anomalous')) as thin
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
           (array_agg(r.rows_written order by r.started_at desc))[1] as rows_last_run,
           (array_agg(r.thin order by r.started_at desc))[1] as thin,
           (array_agg(r.yield_note order by r.started_at desc))[1] as yield_note
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
              when coalesce(l.thin, false)
              then 'The last run finished normally but wrote fewer rows than usual, so some of the very latest figures may still be incomplete.'
         end,
         case when f.forced_stale_reason is not null then 'stale'
              when f.feed = 'meta_ads' and v_days is not null and v_days <= 7 then 'critical'
              when f.feed = 'meta_ads' and v_days is not null and v_days <= 45 then 'warning'
              when coalesce(l.thin, false) then 'warning'
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

-- 2. Expect coverage only from accounts that are ACTUALLY still spending.
-- An account that stopped spending simply has no row, and that is not a gap.
CREATE OR REPLACE FUNCTION public.meta_accounts_uncovered(p_date date)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select count(*)::int
    from (
      select distinct d.account_id
        from daily_metrics d
       where d.level = 'account'
         and d.date = p_date - 1
         and d.spend > 0
    ) still_spending
   where not exists (
     select 1 from daily_metrics x
      where x.level = 'account' and x.account_id = still_spending.account_id and x.date = p_date
   )
$function$;

-- 3. Handover watch: tag by ownership as well as by PRM_ naming, and keep the
-- question open (with today's numbers) while unexplained spend continues.
CREATE OR REPLACE FUNCTION public.check_ad_account_handover()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_first date; v_unknown int := 0; v_alert int := 0; r record;
BEGIN
  -- (a) Anything named PRM_ is Parami.
  UPDATE public.ad_entities e SET agency_code = 'PRM'
   WHERE e.agency_code IS DISTINCT FROM 'PRM'
     AND (
       (e.level = 'campaign' AND e.name ILIKE 'PRM\_%')
       OR EXISTS (SELECT 1 FROM public.ad_entities c
                   WHERE c.entity_id = e.parent_id AND c.name ILIKE 'PRM\_%')
       OR EXISTS (SELECT 1 FROM public.ad_entities s
                    JOIN public.ad_entities c ON c.entity_id = s.parent_id
                   WHERE s.entity_id = e.parent_id AND c.name ILIKE 'PRM\_%')
     );

  -- (b) Anything spending inside an account during a team's ownership period
  -- belongs to that team, whatever the campaign is called. This is what the
  -- PRM_-name-only rule missed when Parami launched "PD_Lead_17_Sep_26".
  UPDATE public.ad_entities e SET agency_code = o.agency_code
    FROM public.ad_account_ownership o
   WHERE e.account_id = o.account_id
     AND e.agency_code IS DISTINCT FROM o.agency_code
     AND EXISTS (
       SELECT 1 FROM public.daily_metrics d
        WHERE d.entity_id = e.entity_id
          AND d.spend > 0
          AND d.date >= o.valid_from
          AND (o.valid_to IS NULL OR d.date <= o.valid_to)
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.daily_metrics d2
        WHERE d2.entity_id = e.entity_id
          AND d2.spend > 0
          AND d2.date < o.valid_from
     );

  SELECT min(d.date) INTO v_first
    FROM public.daily_metrics d
    JOIN public.ad_entities e ON e.entity_id = d.entity_id
   WHERE d.level = 'campaign' AND d.spend > 0
     AND (e.name ILIKE 'PRM\_%' OR e.agency_code = 'PRM');

  IF v_first IS NOT NULL THEN
    INSERT INTO public.review_items (kind, ref_id, title, detail, evidence, status)
    SELECT 'owner_action', 'parami_first_spend',
           'Parami''s first ad spend has arrived — check its first leads',
           'The first Parami spend was on ' || to_char(v_first,'DD Mon YYYY') ||
           '. Worth checking that leads from it are arriving and showing as Parami.',
           jsonb_build_object('first_spend_date', v_first), 'open'
     WHERE NOT EXISTS (SELECT 1 FROM public.review_items WHERE ref_id = 'parami_first_spend');
    v_alert := 1;
  END IF;

  FOR r IN
    SELECT d.account_id, a.name AS acct_name, min(d.date) AS from_d,
           round(sum(d.spend)) AS spend, string_agg(DISTINCT e.name, ', ') AS camps
      FROM public.daily_metrics d
      JOIN public.ad_entities e ON e.entity_id = d.entity_id
      JOIN public.ad_accounts a ON a.account_id = d.account_id
     WHERE d.level = 'campaign' AND d.spend > 0 AND d.date > DATE '2026-09-15'
       AND e.name NOT ILIKE 'PRM\_%'
       AND coalesce(e.agency_code, '') <> 'PRM'
       AND EXISTS (SELECT 1 FROM public.ad_account_ownership o
                    WHERE o.account_id = d.account_id AND o.valid_to IS NOT NULL)
       AND public.account_agency_at(d.account_id, d.date) IS NULL
     GROUP BY 1,2
  LOOP
    INSERT INTO public.review_items (kind, ref_id, title, detail, evidence, status)
    VALUES ('owner_action', 'handover_unknown_' || r.account_id,
           'New spend in an old ScaleX account under a non-Parami campaign name — whose is it?',
           'The account "' || r.acct_name || '" started spending again on ' ||
           to_char(r.from_d,'DD Mon YYYY') || ' (about ' || r.spend ||
           ' so far) under campaigns not named PRM_: ' || r.camps ||
           '. Tell me which team this belongs to so the spend lands in the right place.',
           jsonb_build_object('account_id', r.account_id, 'from_date', r.from_d,
                              'spend', r.spend, 'campaigns', r.camps), 'open')
    ON CONFLICT (kind, coalesce(ref_id, '')) WHERE status = 'open'
    DO UPDATE SET detail = excluded.detail, evidence = excluded.evidence, updated_at = now();
    v_unknown := v_unknown + 1;
  END LOOP;

  RETURN jsonb_build_object('parami_alert', v_alert, 'unknown_spend_accounts', v_unknown);
END $function$;

-- 4. Lead-to-team refresh: bounded by default so it can never time out.
DROP FUNCTION IF EXISTS public.refresh_lead_agency();

CREATE OR REPLACE FUNCTION public.refresh_lead_agency(p_days integer DEFAULT 45)
 RETURNS TABLE(agency_code text, leads bigint, changed bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_changed bigint;
  v_since date := CASE WHEN p_days IS NULL OR p_days <= 0 THEN NULL
                       ELSE current_date - p_days END;
BEGIN
  CREATE TEMP TABLE _la ON COMMIT DROP AS
  SELECT l.lead_id,
         l.agency_code AS old_ac,
         CASE WHEN e.entity_id IS NOT NULL THEN a.agency_code
              ELSE public.agency_code_for(l.utm_source) END AS new_ac
    FROM public.leads l
    LEFT JOIN public.ad_entities e ON e.entity_id = l.ad_entity_ref
    LEFT JOIN public.ad_accounts a ON a.account_id = e.account_id
   WHERE v_since IS NULL
      OR coalesce(l.business_date, (l.captured_at AT TIME ZONE 'UTC')::date) >= v_since
      OR l.ad_matched_at >= (now() - interval '2 days');
  CREATE INDEX ON _la (lead_id);

  UPDATE public.leads l
     SET agency_code = t.new_ac
    FROM _la t
   WHERE t.lead_id = l.lead_id
     AND l.agency_code IS DISTINCT FROM t.new_ac;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  PERFORM public.refresh_lead_attribution();

  IF v_changed > 0 THEN
    PERFORM public.rebuild_metric_baselines();
  END IF;

  RETURN QUERY
  SELECT coalesce(t.new_ac, '(none)'),
         count(*)::bigint,
         count(*) FILTER (WHERE t.old_ac IS DISTINCT FROM t.new_ac)::bigint
    FROM _la t GROUP BY 1 ORDER BY 2 DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.refresh_lead_agency(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.meta_accounts_uncovered(date) TO service_role;
