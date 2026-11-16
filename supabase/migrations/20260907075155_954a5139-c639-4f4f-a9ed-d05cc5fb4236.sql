ALTER TABLE public.agency_spend_status
  ADD COLUMN IF NOT EXISTS ratios_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ratios_hold_reason text;

UPDATE public.agency_spend_status
   SET ratios_hold = true,
       ratios_hold_reason = 'manual hold 2026-09-07: render gate defect allowed all-team cash to be divided by team-only spend; held until the gate fix is verified',
       ratios_computable = false,
       updated_at = now();

CREATE OR REPLACE FUNCTION public.refresh_agency_ratio_flags(p_days integer DEFAULT 30)
 RETURNS TABLE(agency_code text, spend_synced boolean, ad_coverage_pct numeric, ratios_computable boolean, ratio_note text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      AND l.business_date <= (current_date - 2)
    GROUP BY 1
  ), calc AS (
    SELECT s.agency_code AS ac,
           s.spend_synced AS synced,
           s.ratios_hold AS held,
           s.ratios_hold_reason AS hold_reason,
           CASE WHEN c.leads_n > 0 THEN round(100 * c.matched_n / c.leads_n, 1) ELSE NULL END AS pct
    FROM agency_spend_status s
    LEFT JOIN cov c ON c.ac = s.agency_code
  )
  UPDATE agency_spend_status s
     SET ad_coverage_pct = calc.pct,
         -- a manual hold always wins: coverage can never switch the gate back on
         ratios_computable = (NOT calc.held) AND calc.synced AND coalesce(calc.pct, 0) >= 60,
         ratio_note = CASE
           WHEN calc.held THEN coalesce(calc.hold_reason, 'per-team ratios are manually held off')
           WHEN NOT calc.synced THEN 'ad spend for this team is not connected'
           WHEN coalesce(calc.pct, 0) < 60 THEN 'only ' || coalesce(calc.pct, 0)::text || '% of this team''s leads trace to ads in its own accounts — below the 60% needed'
           ELSE 'spend connected and ' || calc.pct::text || '% of leads trace to this team''s own ads (last 48h excluded, still resolving)'
         END,
         updated_at = now()
    FROM calc
   WHERE calc.ac = s.agency_code
  RETURNING s.agency_code, s.spend_synced, s.ad_coverage_pct, s.ratios_computable, s.ratio_note;
END;
$function$;