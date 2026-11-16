GRANT eqh_ask_ro TO postgres;
GRANT USAGE, CREATE ON SCHEMA public TO eqh_ask_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO eqh_ask_ro;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM eqh_ask_ro;

DO $do$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'metric_components','metric_series','placement_rollup','entity_rollup',
        'ledger_daily','ledger_monthly','ledger_tier_rollup','ledger_tier_summary',
        'ledger_platform_rollup','ledger_rail_rollup','ledger_campaign_rollup',
        'sales_reconciliation','zoom_event_rows','zoom_session_rows','zoom_retention_curve',
        'lead_tracking_coverage','lead_agency_rollup','lead_page_rollup','lead_template_trend',
        'daily_spend_series','monthly_spend','account_month_rollup','daily_coverage',
        'business_date','agency_code_for','tm_sales_daily','feed_day_strip','proof_summary'
      )
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eqh_ask_ro', r.sig);
  END LOOP;
END $do$;

CREATE OR REPLACE FUNCTION public.ask_run_sql(p_sql text, p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  IF lower(v_sql) ~ '(upsert_|rebuild_|record_|reap_|sync_)' THEN
    RAISE EXCEPTION 'Disallowed function in query';
  END IF;
  SET LOCAL statement_timeout = '10s';
  EXECUTE format(
    'SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (SELECT * FROM (%s) q LIMIT %s) t',
    v_sql,
    least(greatest(coalesce(p_limit, 500), 1), 500)
  ) INTO v_result;
  RETURN v_result;
END $$;

ALTER FUNCTION public.ask_run_sql(text, integer) RESET ALL;
ALTER FUNCTION public.ask_run_sql(text, integer) SET search_path = public;
ALTER FUNCTION public.ask_run_sql(text, integer) OWNER TO eqh_ask_ro;
REVOKE CREATE ON SCHEMA public FROM eqh_ask_ro;
REVOKE ALL ON FUNCTION public.ask_run_sql(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ask_run_sql(text, integer) TO service_role;