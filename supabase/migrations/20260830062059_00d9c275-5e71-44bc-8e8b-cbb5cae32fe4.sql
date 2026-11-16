create or replace function public.ledger_tier_rollup(p_start date, p_end date)
returns table(product_tier text, rows_count bigint, buyers bigint, sales bigint, collected numeric, pending numeric, avg_ticket numeric)
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(l.product_tier, 'UNCLASSIFIED') as product_tier,
         count(*)::bigint as rows_count,
         count(distinct l.email_key)::bigint as buyers,
         coalesce(sum(case when l.is_new_sale then 1 else 0 end), 0)::bigint as sales,
         coalesce(sum(l.amount_received), 0)::numeric as collected,
         coalesce(sum(l.amount_pending), 0)::numeric as pending,
         case when coalesce(sum(case when l.is_new_sale then 1 else 0 end), 0) > 0
              then coalesce(sum(l.amount_received), 0) / sum(case when l.is_new_sale then 1 else 0 end)
              else null end as avg_ticket
    from ledger_inflow l
   where l.business_date between p_start and p_end
   group by 1
   order by collected desc
$$;

revoke execute on function public.ledger_tier_rollup(date, date) from anon, public;
grant execute on function public.ledger_tier_rollup(date, date) to authenticated, service_role;