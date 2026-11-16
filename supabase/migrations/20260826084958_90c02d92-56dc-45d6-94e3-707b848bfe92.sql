REVOKE ALL ON FUNCTION public.account_month_rollup(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.monthly_spend(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_daily_metrics(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_ad_entities(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_month_rollup(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.monthly_spend(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_daily_metrics(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_ad_entities(jsonb) TO service_role;