
revoke execute on function public.entity_grain_counts(date,date) from authenticated;
revoke execute on function public.placement_rollup(date,date) from authenticated;
revoke execute on function public.ledger_sale_timing_monthly(date,date,text) from authenticated;
grant execute on function public.entity_grain_counts(date,date) to service_role;
grant execute on function public.placement_rollup(date,date) to service_role;
grant execute on function public.ledger_sale_timing_monthly(date,date,text) to service_role;
