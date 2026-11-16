-- N6: a bulk re-derivation changes the shape of a normal day. Rebuilding the
-- baselines here means no correction can leave the alerting layer comparing
-- today against a world that no longer exists.
CREATE OR REPLACE FUNCTION public.refresh_lead_agency()
 RETURNS TABLE(agency_code text, leads bigint, changed bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_changed bigint;
BEGIN
  CREATE TEMP TABLE _la ON COMMIT DROP AS
  SELECT l.lead_id,
         l.agency_code AS old_ac,
         CASE WHEN e.entity_id IS NOT NULL THEN a.agency_code
              ELSE public.agency_code_for(l.utm_source) END AS new_ac
    FROM public.leads l
    LEFT JOIN public.ad_entities e ON e.entity_id = l.ad_entity_ref
    LEFT JOIN public.ad_accounts a ON a.account_id = e.account_id;
  CREATE INDEX ON _la (lead_id);

  UPDATE public.leads l
     SET agency_code = t.new_ac
    FROM _la t
   WHERE t.lead_id = l.lead_id
     AND l.agency_code IS DISTINCT FROM t.new_ac;
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  -- The money side reads lead_attribution_mv; refreshing it here is what stops
  -- a corrected history from showing on the lead side and not the cash side.
  PERFORM public.refresh_lead_attribution();

  -- Only rebuild the normal-range baselines when something actually moved.
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