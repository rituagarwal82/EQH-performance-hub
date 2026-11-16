-- 1. "unknown" becomes representable
ALTER TABLE public.daily_metrics
  ALTER COLUMN leads DROP NOT NULL,
  ALTER COLUMN leads DROP DEFAULT,
  ALTER COLUMN landing_page_views DROP NOT NULL,
  ALTER COLUMN landing_page_views DROP DEFAULT,
  ALTER COLUMN purchases DROP NOT NULL,
  ALTER COLUMN purchases DROP DEFAULT;

-- 2. importer: a missing action writes NULL, never 0
CREATE OR REPLACE FUNCTION public.upsert_daily_metrics(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  WITH incoming AS (
    SELECT
      (r->>'date')::date AS date,
      r->>'account_id' AS account_id,
      NULLIF(r->>'entity_id', '') AS entity_id,
      r->>'level' AS level,
      NULLIF(r->>'placement', '') AS placement,
      COALESCE((r->>'spend')::numeric, 0) AS spend,
      COALESCE((r->>'impressions')::bigint, 0) AS impressions,
      COALESCE((r->>'link_clicks')::int, 0) AS link_clicks,
      (r->>'landing_page_views')::int AS landing_page_views,
      (r->>'leads')::int AS leads,
      (r->>'purchases')::int AS purchases
    FROM jsonb_array_elements(p_rows) AS r
  ), collapsed AS (
    SELECT
      date, account_id, entity_id, level, placement,
      sum(spend) AS spend,
      sum(impressions) AS impressions,
      sum(link_clicks) AS link_clicks,
      CASE WHEN count(landing_page_views) = 0 THEN NULL ELSE sum(landing_page_views) END AS landing_page_views,
      CASE WHEN count(leads) = 0 THEN NULL ELSE sum(leads) END AS leads,
      CASE WHEN count(purchases) = 0 THEN NULL ELSE sum(purchases) END AS purchases
    FROM incoming
    GROUP BY date, account_id, entity_id, level, placement
  ), upserted AS (
    INSERT INTO public.daily_metrics
      (date, account_id, entity_id, level, placement, spend, impressions,
       link_clicks, landing_page_views, leads, purchases, synced_at)
    SELECT date, account_id, entity_id, level, placement, spend, impressions,
           link_clicks, landing_page_views, leads, purchases, now()
    FROM collapsed
    ON CONFLICT (date, account_id, COALESCE(entity_id, ''), level, COALESCE(placement, ''))
    DO UPDATE SET
      spend = EXCLUDED.spend,
      impressions = EXCLUDED.impressions,
      link_clicks = EXCLUDED.link_clicks,
      landing_page_views = EXCLUDED.landing_page_views,
      leads = EXCLUDED.leads,
      purchases = EXCLUDED.purchases,
      synced_at = now()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$function$;

-- 3. lead tracking status on accounts
ALTER TABLE public.ad_accounts
  ADD COLUMN IF NOT EXISTS lead_tracking_status text NOT NULL DEFAULT 'unknown'
  CHECK (lead_tracking_status IN ('working','broken','unknown','not_applicable'));

UPDATE public.ad_accounts SET lead_tracking_status = 'working'  WHERE account_id = '1249430309131428';
UPDATE public.ad_accounts SET lead_tracking_status = 'broken'   WHERE account_id IN ('699110549552181','587640350334915');

-- 4. rollup carries the full measured surface + the tracking verdict
DROP FUNCTION IF EXISTS public.account_month_rollup(date, date);
CREATE OR REPLACE FUNCTION public.account_month_rollup(p_start date, p_end date)
 RETURNS TABLE(
   account_id text, name text, agency_code text, is_active boolean,
   lead_tracking_status text,
   spend numeric, leads bigint, impressions bigint,
   landing_page_views bigint, purchases bigint, link_clicks bigint,
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
  GROUP BY a.account_id, a.name, a.agency_code, a.is_active, a.lead_tracking_status
  ORDER BY COALESCE(SUM(m.spend), 0) DESC, a.name ASC
$function$;

REVOKE EXECUTE ON FUNCTION public.account_month_rollup(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_month_rollup(date, date) TO authenticated, service_role;

-- 5. entity (creative-grain) rollup, same honesty rules
CREATE OR REPLACE FUNCTION public.entity_rollup(p_start date, p_end date, p_level text)
 RETURNS TABLE(
   entity_id text, entity_name text, account_id text, account_name text,
   lead_tracking_status text, status text,
   spend numeric, leads bigint, impressions bigint,
   landing_page_views bigint, purchases bigint, link_clicks bigint,
   days_with_data bigint, days_missing_leads bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    m.entity_id,
    e.name,
    m.account_id,
    a.name,
    a.lead_tracking_status,
    e.status,
    SUM(m.spend)::numeric,
    SUM(m.leads)::bigint,
    SUM(m.impressions)::bigint,
    SUM(m.landing_page_views)::bigint,
    SUM(m.purchases)::bigint,
    SUM(m.link_clicks)::bigint,
    COUNT(*)::bigint,
    COUNT(*) FILTER (WHERE m.leads IS NULL)::bigint
  FROM public.daily_metrics m
  JOIN public.ad_accounts a ON a.account_id = m.account_id
  LEFT JOIN public.ad_entities e ON e.entity_id = m.entity_id
  WHERE m.level = p_level
    AND m.entity_id IS NOT NULL
    AND m.date >= p_start AND m.date <= p_end
  GROUP BY m.entity_id, e.name, m.account_id, a.name, a.lead_tracking_status, e.status
  ORDER BY SUM(m.spend) DESC NULLS LAST
$function$;

REVOKE EXECUTE ON FUNCTION public.entity_rollup(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.entity_rollup(date, date, text) TO authenticated, service_role;

-- 6. daily spend series for an arbitrary range
CREATE OR REPLACE FUNCTION public.daily_spend_series(p_start date, p_end date)
 RETURNS TABLE(date date, spend numeric, leads bigint, measured_spend numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    m.date,
    SUM(m.spend)::numeric,
    SUM(m.leads)::bigint,
    SUM(m.spend) FILTER (WHERE a.lead_tracking_status = 'working')::numeric
  FROM public.daily_metrics m
  JOIN public.ad_accounts a ON a.account_id = m.account_id
  WHERE m.level = 'account' AND m.date >= p_start AND m.date <= p_end
  GROUP BY m.date
  ORDER BY m.date
$function$;

REVOKE EXECUTE ON FUNCTION public.daily_spend_series(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.daily_spend_series(date, date) TO authenticated, service_role;

-- 7. break-even model inputs, owner-editable
INSERT INTO public.app_settings (key, value, description) VALUES
  ('breakeven_l1_price', '6990', 'L1 offer price in INR (gross).'),
  ('breakeven_backend_price', '230000', 'Back-end programme price in INR (gross).'),
  ('breakeven_ascension_rate', '21.5', 'Percentage of L1 buyers who ascend to the back-end programme.'),
  ('breakeven_buyers_per_1000', '77.4', 'L1 buyers per 1,000 registrations. Seeded from measured 2026 data: 1,899 distinct L1 buyer emails against 24,538 registrations on the one account with working lead tracking.')
ON CONFLICT (key) DO NOTHING;