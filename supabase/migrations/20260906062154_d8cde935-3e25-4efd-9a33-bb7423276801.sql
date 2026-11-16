revoke execute on function public.run_invariants(date, date) from public, anon, authenticated;
revoke execute on function public.snapshot_feed_edges() from public, anon, authenticated;
grant execute on function public.run_invariants(date, date) to service_role;
grant execute on function public.snapshot_feed_edges() to service_role;