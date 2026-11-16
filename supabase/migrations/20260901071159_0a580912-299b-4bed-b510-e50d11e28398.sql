create or replace function public.account_matured_sale_rate(p_start date, p_end date)
returns table (matured_leads bigint, matured_sales bigint, sale_rate numeric)
language sql
stable
security definer
set search_path = public
as $$
  with l as (
    select l.email_key, l.business_date
    from public.leads l
    where l.business_date >= p_start
      and l.business_date <= p_end - 14
      and l.is_import = false
      and l.is_registered
      and l.email_key is not null
  ), s as (
    select l.email_key,
           exists (
             select 1 from public.ledger_inflow li
              where li.email_key = l.email_key
                and li.is_new_sale
                and li.business_date >= l.business_date
                and li.business_date <= p_end
           ) as bought
    from l
  )
  select count(*)::bigint,
         count(*) filter (where bought)::bigint,
         case when count(*) > 0
              then count(*) filter (where bought)::numeric / count(*) end
  from s
$$;

revoke all on function public.account_matured_sale_rate(date, date) from public;
grant execute on function public.account_matured_sale_rate(date, date) to service_role;