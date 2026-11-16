-- A direct watch link for each ad, filled by the creative sync when the ad is
-- a public page post. Where it is not public the column stays empty and the
-- email falls back to Ads Manager.
ALTER TABLE public.ad_entities ADD COLUMN IF NOT EXISTS permalink_url text;

-- One place that answers "how is each ad doing", so the email, the weekly note
-- and the Creative screen can never disagree with one another.
--
-- Registrations are people captured in the window whose first touch carries
-- that ad. A sale counts against an ad when one of those people bought the
-- first course in the same window. Spend is the ad's own spend.
CREATE OR REPLACE FUNCTION public.ad_performance(p_days integer DEFAULT 14)
RETURNS TABLE (
  entity_id text,
  ad_name text,
  account_id text,
  agency_code text,
  thumbnail_url text,
  permalink_url text,
  spend numeric,
  registrations integer,
  cost_per_reg numeric,
  sales integer,
  cost_per_sale numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH w AS (
    SELECT (current_date - p_days) AS s, current_date AS e
  ), sp AS (
    SELECT d.entity_id, sum(d.spend)::numeric AS spend
      FROM public.daily_metrics d, w
     WHERE d.level = 'ad' AND d.date BETWEEN w.s AND w.e
     GROUP BY 1
  ), lead_rows AS (
    SELECT l.ad_entity_ref AS entity_id, l.email_key
      FROM public.leads l, w
     WHERE l.ad_entity_ref IS NOT NULL
       AND coalesce(l.business_date, (l.captured_at AT TIME ZONE 'Asia/Kolkata')::date)
             BETWEEN w.s AND w.e
  ), regs AS (
    SELECT entity_id, count(*)::int AS registrations FROM lead_rows GROUP BY 1
  ), buyers AS (
    SELECT DISTINCT sa.email_key
      FROM public.sale_attribution sa, w
     WHERE sa.is_new_sale AND sa.business_date BETWEEN w.s AND w.e
  ), ad_sales AS (
    SELECT lr.entity_id, count(DISTINCT lr.email_key)::int AS sales
      FROM lead_rows lr
      JOIN buyers b ON b.email_key = lr.email_key
     GROUP BY 1
  ), keys AS (
    SELECT entity_id FROM sp
    UNION SELECT entity_id FROM regs
  )
  SELECT k.entity_id,
         e.name,
         e.account_id,
         coalesce(e.agency_code, a.agency_code),
         e.thumbnail_url,
         e.permalink_url,
         coalesce(sp.spend, 0)::numeric,
         coalesce(regs.registrations, 0),
         CASE WHEN coalesce(regs.registrations, 0) > 0
              THEN round(coalesce(sp.spend, 0) / regs.registrations, 0) END,
         coalesce(ad_sales.sales, 0),
         CASE WHEN coalesce(ad_sales.sales, 0) > 0
              THEN round(coalesce(sp.spend, 0) / ad_sales.sales, 0) END
    FROM keys k
    LEFT JOIN public.ad_entities e ON e.entity_id = k.entity_id
    LEFT JOIN public.ad_accounts a ON a.account_id = e.account_id
    LEFT JOIN sp ON sp.entity_id = k.entity_id
    LEFT JOIN regs ON regs.entity_id = k.entity_id
    LEFT JOIN ad_sales ON ad_sales.entity_id = k.entity_id
   WHERE coalesce(sp.spend, 0) > 0 OR coalesce(regs.registrations, 0) > 0;
$$;

GRANT EXECUTE ON FUNCTION public.ad_performance(integer) TO service_role, authenticated;