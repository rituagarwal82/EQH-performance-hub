-- N1(a/c): any bulk re-derivation of team codes must refresh the lookup the
-- money side reads, or the two halves disagree until a new lead happens to arrive.
CREATE OR REPLACE FUNCTION public.refresh_lead_agency()
 RETURNS TABLE(agency_code text, leads bigint, changed bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- The money side reads lead_attribution_mv. Refreshing it here is what stops
  -- a corrected history from showing up on the lead side and not the cash side.
  PERFORM public.refresh_lead_attribution();

  RETURN QUERY
  SELECT coalesce(t.new_ac, '(none)'),
         count(*)::bigint,
         count(*) FILTER (WHERE t.old_ac IS DISTINCT FROM t.new_ac)::bigint
    FROM _la t GROUP BY 1 ORDER BY 2 DESC;
END;
$function$;

-- N1 (spend-symmetry gate): an unknown team is NOT a synced team. The previous
-- COALESCE(..., true) made the gate a no-op for every sale whose team could not
-- be identified, which is why inv_spend_symmetry reported zero: it was vacuous,
-- not clean. Unknown now fails closed.
CREATE OR REPLACE FUNCTION public.agency_spend_synced(p_code text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_code IS NULL THEN false
    ELSE COALESCE(
      (SELECT s.spend_synced FROM public.agency_spend_status s WHERE s.agency_code = p_code),
      false)
  END
$function$;

-- N1(d): both halves of the money picture now read the same buyer-to-advert
-- lookup. ledger_paid_daily previously read the live view while
-- metric_components read the materialised one, so they diverged by construction.
CREATE OR REPLACE FUNCTION public.ledger_paid_daily(p_start date, p_end date)
 RETURNS TABLE(business_date date, collected_all numeric, collected_new_sale numeric, collected_no_lead numeric, collected_instalment numeric, collected_paid_gross numeric, collected_paid_exgst numeric, rows_all bigint, rows_paid bigint, collected_unsynced_gross numeric, rows_unsynced bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
  WITH l AS (
    SELECT li.business_date, li.amount_received, li.revenue_recognized, li.counts_as_sale,
           EXISTS (SELECT 1 FROM public.leads x WHERE x.email_key = li.email_key) AS has_lead,
           EXISTS (SELECT 1 FROM public.lead_attribution_mv la
                    WHERE la.email_key = li.email_key AND la.is_paid) AS has_paid_marker,
           public.agency_spend_synced(
             (SELECT la.agency_code FROM public.lead_attribution_mv la
               WHERE la.email_key = li.email_key AND la.is_paid LIMIT 1)) AS spend_synced
      FROM public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND li.email_key IS NOT NULL
    UNION ALL
    SELECT li.business_date, li.amount_received, li.revenue_recognized, li.counts_as_sale, false, false, false
      FROM public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND li.email_key IS NULL
  )
  SELECT l.business_date,
         coalesce(sum(l.amount_received), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.revenue_recognized), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.revenue_recognized AND NOT l.has_lead), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE NOT l.revenue_recognized), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.revenue_recognized AND l.has_paid_marker AND l.spend_synced), 0)::numeric,
         round(coalesce(sum(l.amount_received) FILTER (WHERE l.revenue_recognized AND l.has_paid_marker AND l.spend_synced), 0)::numeric / 1.18, 2),
         count(*)::bigint,
         count(*) FILTER (WHERE l.counts_as_sale AND l.has_paid_marker AND l.spend_synced)::bigint,
         coalesce(sum(l.amount_received) FILTER (WHERE l.revenue_recognized AND l.has_paid_marker AND NOT l.spend_synced), 0)::numeric,
         count(*) FILTER (WHERE l.counts_as_sale AND l.has_paid_marker AND NOT l.spend_synced)::bigint
    FROM l GROUP BY l.business_date ORDER BY l.business_date
$function$;

-- N1(b): the lookup gets its own daily rebuild, ahead of the baseline rebuild
-- at 05:40, so the day's figures are computed against current team codes.
SELECT cron.schedule(
  'refresh-lead-attribution-daily',
  '20 5 * * *',
  $$SELECT public.refresh_lead_attribution();$$
);