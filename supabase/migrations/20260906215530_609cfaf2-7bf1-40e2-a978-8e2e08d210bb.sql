
REVOKE EXECUTE ON FUNCTION public.inv_orphan_history_rows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_orphan_history_rows() TO service_role;
