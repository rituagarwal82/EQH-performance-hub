-- Which ads the retry should ask Meta about again: ads that actually spent
-- money recently and still have no picture or no creative text.
CREATE OR REPLACE FUNCTION public.creative_retry_targets(p_days integer DEFAULT 30)
RETURNS TABLE (entity_id text, account_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.entity_id, e.account_id
    FROM public.ad_entities e
   WHERE e.level = 'ad'
     AND (e.thumbnail_url IS NULL OR e.creative_fetch_status <> 'ok')
     AND EXISTS (
       SELECT 1 FROM public.daily_metrics d
        WHERE d.entity_id = e.entity_id
          AND d.level = 'ad'
          AND d.date >= current_date - p_days
          AND d.spend > 0
     )
   ORDER BY e.entity_id;
$$;

GRANT EXECUTE ON FUNCTION public.creative_retry_targets(integer) TO service_role, authenticated;