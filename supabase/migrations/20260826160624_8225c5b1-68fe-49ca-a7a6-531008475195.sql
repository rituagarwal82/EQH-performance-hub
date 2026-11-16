-- 1. Retire Source of Student attribution
DROP FUNCTION IF EXISTS public.ledger_source_rollup(date, date, text);
DROP FUNCTION IF EXISTS public.reapply_source_map();
DROP TABLE IF EXISTS public.source_map;
DROP INDEX IF EXISTS public.ledger_inflow_source_idx;
ALTER TABLE public.ledger_inflow DROP COLUMN IF EXISTS source_code;
COMMENT ON COLUMN public.ledger_inflow.source_of_student_raw IS 'UNRELIABLE. Keyed by accounts after the fact; disagrees with lead utm_source on 93% of sales. Reference only - never use in any calculation.';

-- 2. Traffic source rules: classify raw utm_source strings
CREATE TABLE public.utm_source_map (
  raw text PRIMARY KEY,
  platform text NOT NULL DEFAULT 'unknown',
  is_paid boolean NOT NULL DEFAULT false,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.utm_source_map TO authenticated;
GRANT ALL ON public.utm_source_map TO service_role;
ALTER TABLE public.utm_source_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read utm_source_map" ON public.utm_source_map FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can edit utm_source_map" ON public.utm_source_map FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Service role manages utm_source_map" ON public.utm_source_map TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.utm_source_map (raw, platform, is_paid, note) VALUES
  ('rituagarwal2', 'meta', true, 'Ad account name used as utm_source. Ad account, NOT an agency.'),
  ('rituagarwal2 facebook', 'meta', true, 'Ad account + platform concatenated'),
  ('facebook', 'meta', true, NULL),
  ('fb', 'meta', true, NULL),
  ('instagram', 'meta', true, NULL),
  ('ig', 'meta', true, NULL),
  ('google', 'google', true, NULL),
  ('youtube', 'google', true, NULL),
  ('zoom', 'zoom', false, 'Re-registration from a Zoom link - not an acquisition source'),
  ('bio', 'organic', false, 'Instagram bio link - organic'),
  ('/energy', 'unknown', false, 'Page path leaked into utm_source'),
  ('organic', 'organic', false, NULL),
  ('podcast', 'podcast', false, NULL);

-- 3. Lead records: the attribution system of record
CREATE TABLE public.leads (
  lead_id text PRIMARY KEY,
  source_system text NOT NULL,
  email_raw text,
  email_key text,
  phone text,
  name text,
  captured_at timestamptz,
  business_date date,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  platform text,
  ad_account_id text,
  campaign_id text,
  adset_id text,
  ad_id text,
  agency_code text,
  landing_page text,
  raw jsonb,
  synced_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.leads TO authenticated;
GRANT ALL ON public.leads TO service_role;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read leads" ON public.leads FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages leads" ON public.leads TO service_role USING (true) WITH CHECK (true);
CREATE INDEX leads_email_idx ON public.leads (email_key);
CREATE INDEX leads_captured_idx ON public.leads (captured_at);
CREATE INDEX leads_campaign_idx ON public.leads (utm_campaign);

-- 4. Best lead per person, with paid classification
CREATE OR REPLACE VIEW public.lead_attribution AS
SELECT DISTINCT ON (l.email_key)
  l.email_key,
  l.captured_at,
  l.utm_source,
  l.utm_campaign,
  l.utm_medium,
  COALESCE(NULLIF(l.platform, ''), m.platform, 'unknown') AS platform,
  l.ad_account_id,
  l.campaign_id,
  l.ad_id,
  l.agency_code,
  (COALESCE(m.is_paid, false)
    OR l.ad_id IS NOT NULL
    OR l.campaign_id IS NOT NULL
    OR lower(COALESCE(l.utm_medium, '')) IN ('cpc', 'paid', 'ppc', 'paid_social')
  ) AS is_paid
FROM public.leads l
LEFT JOIN public.utm_source_map m ON m.raw = lower(btrim(COALESCE(l.utm_source, '')))
WHERE l.email_key IS NOT NULL AND l.email_key <> ''
ORDER BY l.email_key, l.captured_at ASC NULLS LAST;

GRANT SELECT ON public.lead_attribution TO authenticated;
GRANT SELECT ON public.lead_attribution TO service_role;

-- 5. Buyer-level attribution base + reporting routines
CREATE OR REPLACE FUNCTION public.ledger_attribution_buckets(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER')
RETURNS TABLE(bucket text, buyers bigint, sales bigint, collected numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH b AS (
    SELECT i.email_key,
           SUM(CASE WHEN i.is_new_sale THEN 1 ELSE 0 END)::bigint AS sales,
           SUM(i.amount_received)::numeric AS collected
    FROM public.ledger_inflow i
    WHERE i.product_tier = p_tier AND i.business_date BETWEEN p_start AND p_end
    GROUP BY i.email_key
  )
  SELECT
    CASE WHEN a.email_key IS NULL THEN 'NO_LEAD_RECORD'
         WHEN a.is_paid THEN 'PAID'
         ELSE 'LEAD_NOT_PAID' END,
    COUNT(*)::bigint,
    SUM(b.sales)::bigint,
    SUM(b.collected)::numeric
  FROM b LEFT JOIN public.lead_attribution a ON a.email_key = b.email_key
  GROUP BY 1
$$;

CREATE OR REPLACE FUNCTION public.ledger_platform_rollup(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER')
RETURNS TABLE(platform text, is_paid boolean, buyers bigint, sales bigint, collected numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH b AS (
    SELECT i.email_key,
           SUM(CASE WHEN i.is_new_sale THEN 1 ELSE 0 END)::bigint AS sales,
           SUM(i.amount_received)::numeric AS collected
    FROM public.ledger_inflow i
    WHERE i.product_tier = p_tier AND i.business_date BETWEEN p_start AND p_end
    GROUP BY i.email_key
  )
  SELECT a.platform, a.is_paid, COUNT(*)::bigint, SUM(b.sales)::bigint, SUM(b.collected)::numeric
  FROM b JOIN public.lead_attribution a ON a.email_key = b.email_key
  GROUP BY a.platform, a.is_paid
  ORDER BY SUM(b.sales) DESC NULLS LAST
$$;

CREATE OR REPLACE FUNCTION public.ledger_campaign_rollup(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER')
RETURNS TABLE(utm_campaign text, platform text, is_paid boolean, buyers bigint, sales bigint, collected numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH b AS (
    SELECT i.email_key,
           SUM(CASE WHEN i.is_new_sale THEN 1 ELSE 0 END)::bigint AS sales,
           SUM(i.amount_received)::numeric AS collected
    FROM public.ledger_inflow i
    WHERE i.product_tier = p_tier AND i.business_date BETWEEN p_start AND p_end
    GROUP BY i.email_key
  )
  SELECT NULLIF(btrim(COALESCE(a.utm_campaign, '')), ''), a.platform, a.is_paid,
         COUNT(*)::bigint, SUM(b.sales)::bigint, SUM(b.collected)::numeric
  FROM b JOIN public.lead_attribution a ON a.email_key = b.email_key
  GROUP BY 1, 2, 3
  ORDER BY SUM(b.sales) DESC NULLS LAST
$$;

CREATE OR REPLACE FUNCTION public.ledger_lead_coverage(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER')
RETURNS TABLE(buyers bigint, matched bigint, unmatched bigint, coverage_pct numeric, with_campaign bigint, campaign_pct numeric, leads_total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH b AS (
    SELECT DISTINCT i.email_key
    FROM public.ledger_inflow i
    WHERE i.product_tier = p_tier AND i.business_date BETWEEN p_start AND p_end
      AND i.email_key IS NOT NULL AND i.email_key <> ''
  ), j AS (
    SELECT b.email_key, a.email_key IS NOT NULL AS matched,
           NULLIF(btrim(COALESCE(a.utm_campaign, '')), '') IS NOT NULL AS has_campaign
    FROM b LEFT JOIN public.lead_attribution a ON a.email_key = b.email_key
  )
  SELECT COUNT(*)::bigint,
         COUNT(*) FILTER (WHERE matched)::bigint,
         COUNT(*) FILTER (WHERE NOT matched)::bigint,
         CASE WHEN COUNT(*) = 0 THEN NULL ELSE round(100.0 * COUNT(*) FILTER (WHERE matched) / COUNT(*), 1) END,
         COUNT(*) FILTER (WHERE has_campaign)::bigint,
         CASE WHEN COUNT(*) = 0 THEN NULL ELSE round(100.0 * COUNT(*) FILTER (WHERE has_campaign) / COUNT(*), 1) END,
         (SELECT COUNT(*) FROM public.leads)::bigint
  FROM j
$$;

REVOKE EXECUTE ON FUNCTION public.ledger_attribution_buckets(date, date, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.ledger_platform_rollup(date, date, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.ledger_campaign_rollup(date, date, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.ledger_lead_coverage(date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_attribution_buckets(date, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ledger_platform_rollup(date, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ledger_campaign_rollup(date, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ledger_lead_coverage(date, date, text) TO authenticated, service_role;