REVOKE ALL ON FUNCTION public.ask_run_sql(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ask_run_sql(text, integer) TO service_role;