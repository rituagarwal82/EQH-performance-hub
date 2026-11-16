CREATE OR REPLACE FUNCTION public.ask_run_sql(p_sql text, p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
  SET LOCAL statement_timeout = '25s';
  EXECUTE format(
    'SELECT coalesce(jsonb_agg(t), ''[]''::jsonb) FROM (SELECT * FROM (%s) q LIMIT %s) t',
    v_sql,
    least(greatest(coalesce(p_limit, 500), 1), 500)
  ) INTO v_result;
  RETURN v_result;
END
$fn$;