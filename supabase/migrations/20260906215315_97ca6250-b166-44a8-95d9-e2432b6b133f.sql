
CREATE OR REPLACE FUNCTION public.refresh_agency_ratio_flags(p_days integer DEFAULT 30)
RETURNS TABLE(agency_code text, spend_synced boolean, ad_coverage_pct numeric, ratios_computable boolean, ratio_note text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  RETURN QUERY
  WITH cov AS (
    SELECT l.agency_code AS ac,
           count(*)::numeric AS leads_n,
           count(*) FILTER (
             WHERE l.ad_entity_ref IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM ad_entities e
                 JOIN ad_accounts a ON a.account_id = e.account_id
                 WHERE e.entity_id = l.ad_entity_ref
                   AND a.agency_code = l.agency_code
               )
           )::numeric AS matched_n
    FROM leads l
    WHERE l.agency_code IS NOT NULL
      AND l.business_date >= (current_date - p_days)
      -- the newest leads' ad links are still resolving; counting them
      -- would overstate coverage
      AND l.business_date <= (current_date - 2)
    GROUP BY 1
  ), calc AS (
    SELECT s.agency_code AS ac,
           s.spend_synced AS synced,
           CASE WHEN c.leads_n > 0 THEN round(100 * c.matched_n / c.leads_n, 1) ELSE NULL END AS pct
    FROM agency_spend_status s
    LEFT JOIN cov c ON c.ac = s.agency_code
  )
  UPDATE agency_spend_status s
     SET ad_coverage_pct = calc.pct,
         ratios_computable = (calc.synced AND coalesce(calc.pct, 0) >= 60),
         ratio_note = CASE
           WHEN NOT calc.synced THEN 'ad spend for this team is not connected'
           WHEN coalesce(calc.pct, 0) < 60 THEN 'only ' || coalesce(calc.pct, 0)::text || '% of this team''s leads trace to ads in its own accounts — below the 60% needed'
           ELSE 'spend connected and ' || calc.pct::text || '% of leads trace to this team''s own ads (last 48h excluded, still resolving)'
         END,
         updated_at = now()
    FROM calc
   WHERE calc.ac = s.agency_code
  RETURNING s.agency_code, s.spend_synced, s.ad_coverage_pct, s.ratios_computable, s.ratio_note;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.zoom_retention_curve(p_session_uuid text)
RETURNS TABLE(minute integer, present bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  with s as (
    select public.session_t0(start_time) as t0,
           greatest(
             ceil(extract(epoch from (
               coalesce(end_time, start_time + (coalesce(duration_min,0) || ' minutes')::interval)
               - public.session_t0(start_time))) / 60.0)::int, 5) as dur
    from public.zoom_sessions where session_uuid = p_session_uuid
  ), marks as (
    select generate_series(0, (select dur from s), 5) as minute
  )
  select
    m.minute::int,
    (select count(*) from public.zoom_attendance a, s
      where a.session_uuid = p_session_uuid
        and a.first_join <= s.t0 + (m.minute || ' minutes')::interval
        and a.last_leave >= s.t0 + (m.minute || ' minutes')::interval)
  from marks m
  order by m.minute
$fn$;
