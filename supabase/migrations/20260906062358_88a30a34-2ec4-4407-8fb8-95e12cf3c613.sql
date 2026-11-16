revoke execute on function public.enforce_watchdog_budgets() from public, anon, authenticated;
revoke execute on function public.run_golden(text, text, text) from public, anon, authenticated;
revoke execute on function public.watchdog_recalibration_resolved() from public, anon, authenticated;
revoke execute on function public.proof_history_strip(integer) from public, anon;
grant execute on function public.enforce_watchdog_budgets() to service_role;
grant execute on function public.run_golden(text, text, text) to service_role;
grant execute on function public.proof_history_strip(integer) to service_role;