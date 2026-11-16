REVOKE EXECUTE ON FUNCTION public.record_reconciliations(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_reconciliations(jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.proof_inputs(date, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.proof_closed_months() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.proof_summary() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.proof_detail(integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.proof_inputs(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.proof_closed_months() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.proof_summary() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.proof_detail(integer) TO authenticated, service_role;