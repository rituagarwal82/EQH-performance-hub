REVOKE ALL ON FUNCTION public.upsert_tm_payments(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_tm_payments(jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.rebuild_tm_sales() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_tm_sales() TO service_role;

REVOKE ALL ON FUNCTION public.tm_sales_daily(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tm_sales_daily(date, date) TO authenticated, service_role;