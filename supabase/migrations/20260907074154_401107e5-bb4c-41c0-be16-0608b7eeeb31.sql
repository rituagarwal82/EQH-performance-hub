REVOKE ALL ON FUNCTION public.cron_post(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.close_finished_months() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_post(text) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.close_finished_months() TO postgres, service_role;