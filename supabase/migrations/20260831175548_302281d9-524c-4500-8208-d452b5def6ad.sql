CREATE TABLE public.analyst_briefs (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  for_date date NOT NULL UNIQUE,
  brief_md text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  model text,
  tokens integer,
  attempts integer NOT NULL DEFAULT 1,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
GRANT SELECT ON public.analyst_briefs TO authenticated;
GRANT ALL ON public.analyst_briefs TO service_role;
ALTER TABLE public.analyst_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read analyst_briefs" ON public.analyst_briefs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages analyst_briefs" ON public.analyst_briefs FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE public.ask_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  question text NOT NULL,
  sql text,
  rows integer,
  answer text,
  error text,
  duration_ms integer,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX ask_log_created_at_idx ON public.ask_log (created_at DESC);
GRANT SELECT ON public.ask_log TO authenticated;
GRANT ALL ON public.ask_log TO service_role;
ALTER TABLE public.ask_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read ask_log" ON public.ask_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages ask_log" ON public.ask_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Cost per click and click-to-registration for one day, against the trailing
-- 28-day median of the same two ratios. Every figure the brief may cite about
-- mechanism is computed here, in SQL, never by the model.
CREATE OR REPLACE FUNCTION public.analyst_decomposition(p_date date)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH d AS (
    SELECT m.date,
           SUM(m.spend) AS spend,
           SUM(m.impressions) AS impressions,
           SUM(m.link_clicks) AS link_clicks,
           SUM(m.leads) FILTER (WHERE m.leads IS NOT NULL) AS leads
    FROM public.daily_metrics m
    JOIN public.ad_accounts a ON a.account_id = m.account_id
    WHERE m.level = 'account'
      AND a.is_active
      AND m.date BETWEEN p_date - 28 AND p_date
    GROUP BY m.date
  ), r AS (
    SELECT date,
           spend, impressions, link_clicks, leads,
           CASE WHEN link_clicks > 0 THEN spend / link_clicks END AS cpc,
           CASE WHEN link_clicks > 0 AND leads IS NOT NULL THEN leads::numeric / link_clicks END AS click_to_lead,
           CASE WHEN impressions > 0 THEN link_clicks::numeric / impressions END AS ctr
    FROM d
  )
  SELECT jsonb_build_object(
    'date', p_date,
    'today', (SELECT to_jsonb(r) FROM r WHERE r.date = p_date),
    'baseline_28d', (
      SELECT jsonb_build_object(
        'days', COUNT(*),
        'cpc_median', percentile_cont(0.5) WITHIN GROUP (ORDER BY cpc),
        'click_to_lead_median', percentile_cont(0.5) WITHIN GROUP (ORDER BY click_to_lead),
        'ctr_median', percentile_cont(0.5) WITHIN GROUP (ORDER BY ctr)
      ) FROM r WHERE r.date < p_date
    )
  );
$$;
GRANT EXECUTE ON FUNCTION public.analyst_decomposition(date) TO service_role, authenticated;

-- Read-only identity for the natural-language question feature.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eqh_ask_ro') THEN
    CREATE ROLE eqh_ask_ro NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO eqh_ask_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO eqh_ask_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO eqh_ask_ro;
DO $$
BEGIN
  EXECUTE format('GRANT eqh_ask_ro TO %I', current_user);
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.ask_run_sql(p_sql text, p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET role = 'eqh_ask_ro'
AS $$
DECLARE
  v_sql text;
  v_result jsonb;
BEGIN
  v_sql := btrim(coalesce(p_sql, ''));
  v_sql := regexp_replace(v_sql, ';\s*$', '');
  IF v_sql = '' THEN
    RAISE EXCEPTION 'Empty query';
  END IF;
  IF position(';' IN v_sql) > 0 THEN
    RAISE EXCEPTION 'Only a single statement is allowed';
  END IF;
  IF lower(v_sql) !~ '^(select|with)\s' THEN
    RAISE EXCEPTION 'Only SELECT statements are allowed';
  END IF;
  IF lower(v_sql) ~ '\m(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|do|merge|vacuum|analyze|refresh|comment|reset|listen|notify|prepare|execute|lock|begin|commit|rollback|savepoint|pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|nextval|setval|currval|pg_terminate_backend|pg_cancel_backend|set_config)\M' THEN
    RAISE EXCEPTION 'Disallowed keyword in query';
  END IF;
  SET LOCAL statement_timeout = '10s';
  EXECUTE format(
    'SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (SELECT * FROM (%s) q LIMIT %s) t',
    v_sql,
    least(greatest(coalesce(p_limit, 500), 1), 500)
  ) INTO v_result;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.ask_run_sql(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ask_run_sql(text, integer) TO service_role;