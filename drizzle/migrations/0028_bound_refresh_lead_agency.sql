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
  -- Index-friendly window: business_date is indexed, so the recent slice is a
  -- range scan rather than a full pass over every lead ever captured.
  CREATE TEMP TABLE _la ON COMMIT DROP AS
  SELECT l.lead_id,
         l.agency_code AS old_ac,
         CASE WHEN e.entity_id IS NOT NULL THEN a.agency_code
              ELSE public.agency_code_for(l.utm_source) END AS new_ac
    FROM public.leads l
    LEFT JOIN public.ad_entities e ON e.entity_id = l.ad_entity_ref
    LEFT JOIN public.ad_accounts a ON a.account_id = e.account_id
   WHERE v_since IS NULL
      OR l.business_date >= v_since
      OR (l.business_date IS NULL AND l.captured_at >= (v_since::timestamptz))
      OR l.ad_matched_at >= (now() - interval '2 days');
  CREATE INDEX ON _la (lead_id);

  UPDATE public.leads l
     SET agency_code = t.new_ac
    FROM _la t
   WHERE t.lead_id = l.lead_id
     AND l.agency_code IS DISTINCT FROM t.new_ac;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  -- The expensive downstream work (a full materialised-view rebuild and the
  -- comparison bands) only earns its cost when a lead actually moved team.
  -- Running it on every sync is what timed the lead sync out five times in
  -- the 48 hours to 19 Sep 2026.
  IF v_changed > 0 THEN
    PERFORM public.refresh_lead_attribution();
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
