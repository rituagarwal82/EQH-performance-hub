GRANT EXECUTE ON FUNCTION public.spend_symmetry(date, date) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.inv_spend_symmetry_rows(date, date) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.inv_basis_symmetry_rows(date, date) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.ledger_paid_daily(date, date) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.inv_source_decision_rows(date, date) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.buyer_paid_team(text) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION public.resolve_unified_source_incremental(interval) TO service_role, postgres;