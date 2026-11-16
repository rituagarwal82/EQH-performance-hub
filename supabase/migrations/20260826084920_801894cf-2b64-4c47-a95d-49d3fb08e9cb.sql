-- EQH Performance Engine — core schema

CREATE TABLE public.ad_accounts (
  account_id text PRIMARY KEY,
  name text NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  status text,
  is_active boolean NOT NULL DEFAULT true,
  agency_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.ad_accounts TO authenticated;
GRANT ALL ON public.ad_accounts TO service_role;
ALTER TABLE public.ad_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read ad_accounts" ON public.ad_accounts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages ad_accounts" ON public.ad_accounts FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.ad_entities (
  entity_id text PRIMARY KEY,
  level text NOT NULL CHECK (level IN ('campaign','adset','ad')),
  account_id text NOT NULL REFERENCES public.ad_accounts(account_id) ON DELETE CASCADE,
  parent_id text,
  name text,
  status text,
  agency_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.ad_entities TO authenticated;
GRANT ALL ON public.ad_entities TO service_role;
ALTER TABLE public.ad_entities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read ad_entities" ON public.ad_entities FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages ad_entities" ON public.ad_entities FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX ad_entities_account_idx ON public.ad_entities (account_id);
CREATE INDEX ad_entities_parent_idx ON public.ad_entities (parent_id);

CREATE TABLE public.daily_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date date NOT NULL,
  account_id text NOT NULL REFERENCES public.ad_accounts(account_id) ON DELETE CASCADE,
  entity_id text,
  level text NOT NULL CHECK (level IN ('account','campaign','adset','ad')),
  placement text,
  spend numeric(14,2) NOT NULL DEFAULT 0,
  impressions bigint NOT NULL DEFAULT 0,
  link_clicks integer NOT NULL DEFAULT 0,
  landing_page_views integer NOT NULL DEFAULT 0,
  leads integer NOT NULL DEFAULT 0,
  purchases integer NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now()
);

-- entity_id and placement are nullable, so a plain UNIQUE would not prevent
-- duplicates (NULLs never conflict). Use a COALESCEd unique index instead —
-- duplicate rows would silently inflate every spend figure.
CREATE UNIQUE INDEX daily_metrics_unique_key
  ON public.daily_metrics (date, account_id, COALESCE(entity_id, ''), level, COALESCE(placement, ''));

CREATE INDEX daily_metrics_date_idx ON public.daily_metrics (date);
CREATE INDEX daily_metrics_account_date_idx ON public.daily_metrics (account_id, date);
CREATE INDEX daily_metrics_entity_date_idx ON public.daily_metrics (entity_id, date);

GRANT SELECT ON public.daily_metrics TO authenticated;
GRANT ALL ON public.daily_metrics TO service_role;
ALTER TABLE public.daily_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read daily_metrics" ON public.daily_metrics FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages daily_metrics" ON public.daily_metrics FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  source text,
  rows_written integer NOT NULL DEFAULT 0,
  status text,
  error text
);

GRANT SELECT ON public.sync_runs TO authenticated;
GRANT ALL ON public.sync_runs TO service_role;
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read sync_runs" ON public.sync_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages sync_runs" ON public.sync_runs FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX sync_runs_started_idx ON public.sync_runs (started_at DESC);

-- Rollups -------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.account_month_rollup(p_start date, p_end date)
RETURNS TABLE (
  account_id text,
  name text,
  agency_code text,
  is_active boolean,
  spend numeric,
  leads bigint,
  has_data boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.account_id,
    a.name,
    a.agency_code,
    a.is_active,
    COALESCE(SUM(m.spend), 0)::numeric,
    COALESCE(SUM(m.leads), 0)::bigint,
    COUNT(m.id) > 0
  FROM public.ad_accounts a
  LEFT JOIN public.daily_metrics m
    ON m.account_id = a.account_id
   AND m.level = 'account'
   AND m.date >= p_start
   AND m.date <= p_end
  GROUP BY a.account_id, a.name, a.agency_code, a.is_active
  ORDER BY COALESCE(SUM(m.spend), 0) DESC, a.name ASC
$$;

CREATE OR REPLACE FUNCTION public.monthly_spend(p_year integer)
RETURNS TABLE (month integer, spend numeric, leads bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXTRACT(month FROM m.date)::int,
    SUM(m.spend)::numeric,
    SUM(m.leads)::bigint
  FROM public.daily_metrics m
  WHERE m.level = 'account'
    AND EXTRACT(year FROM m.date) = p_year
  GROUP BY 1
  ORDER BY 1
$$;

-- Bulk upsert helpers (the expression unique index needs raw SQL) ------------

CREATE OR REPLACE FUNCTION public.upsert_daily_metrics(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
      COALESCE((r->>'landing_page_views')::int, 0) AS landing_page_views,
      COALESCE((r->>'leads')::int, 0) AS leads,
      COALESCE((r->>'purchases')::int, 0) AS purchases
    FROM jsonb_array_elements(p_rows) AS r
  ), upserted AS (
    INSERT INTO public.daily_metrics
      (date, account_id, entity_id, level, placement, spend, impressions,
       link_clicks, landing_page_views, leads, purchases, synced_at)
    SELECT date, account_id, entity_id, level, placement, spend, impressions,
           link_clicks, landing_page_views, leads, purchases, now()
    FROM incoming
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
$$;

CREATE OR REPLACE FUNCTION public.upsert_ad_entities(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH upserted AS (
    INSERT INTO public.ad_entities (entity_id, level, account_id, parent_id, name, status, agency_code, updated_at)
    SELECT
      r->>'entity_id', r->>'level', r->>'account_id',
      NULLIF(r->>'parent_id', ''), r->>'name', r->>'status', NULLIF(r->>'agency_code', ''), now()
    FROM jsonb_array_elements(p_rows) AS r
    ON CONFLICT (entity_id) DO UPDATE SET
      level = EXCLUDED.level,
      account_id = EXCLUDED.account_id,
      parent_id = EXCLUDED.parent_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status,
      agency_code = EXCLUDED.agency_code,
      updated_at = now()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.account_month_rollup(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.monthly_spend(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_daily_metrics(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.upsert_ad_entities(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_month_rollup(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.monthly_spend(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_daily_metrics(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_ad_entities(jsonb) TO service_role;

-- Seed accounts ---------------------------------------------------------------

INSERT INTO public.ad_accounts (account_id, name, currency, status, is_active, agency_code) VALUES
  ('1249430309131428', 'Ritu Agarwal 2', 'INR', 'ACTIVE', true, NULL),
  ('1177480620566796', 'Ritu Agarwal-SX-2', 'INR', 'ACTIVE', true, 'SX'),
  ('1091860385814643', 'Ritu Agarwal-SX', 'INR', 'ACTIVE', true, 'SX'),
  ('2929556933907035', 'Ritu-SX3', 'INR', 'ACTIVE', true, 'SX'),
  ('1488704194840585', 'Ritu Ad manager', 'INR', 'ACTIVE', true, NULL),
  ('699110549552181', 'EQH_SD', 'INR', 'ACTIVE', true, 'SD'),
  ('587640350334915', 'Ritu-Sabhi Digital-3', 'INR', 'ACTIVE', true, 'SD'),
  ('514274773001361', 'Ritu Sabhi Digital', 'INR', 'ACTIVE', true, 'SD'),
  ('1766718867459790', 'Ritu Agarwal-Sabhi Digital2', 'INR', 'ACTIVE', true, 'SD'),
  ('171158705384198', 'Ritu Nikunj Ad Ac', 'INR', 'ACTIVE', true, NULL),
  ('886948362374833', 'Ritu New 4', 'INR', 'ACTIVE', true, NULL),
  ('742306694094489', 'Ritu IDLS', 'INR', 'ACTIVE', true, NULL),
  ('1292097099554679', 'Ritu Agarwal (Read-Only)', 'INR', 'ACTIVE', true, NULL),
  ('1475486154247855', 'Ritu Agarwal (Read-Only) 2', 'INR', 'ACTIVE', true, NULL),
  ('517296235376502', 'Ritu Agarwal (disabled by Meta)', 'INR', 'DISABLED', false, NULL),
  ('326788779184576', 'Ritu Agarwal', 'INR', 'ACTIVE', false, NULL);