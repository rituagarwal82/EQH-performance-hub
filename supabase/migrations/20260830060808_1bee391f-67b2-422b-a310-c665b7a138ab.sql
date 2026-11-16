
create or replace function public.ledger_tier_summary(p_start date default null, p_end date default null)
returns table (
  product_tier text,
  buyers bigint,
  sales bigint,
  collected numeric,
  avg_ticket numeric,
  first_date date,
  last_date date
)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(l.product_tier, 'UNCLASSIFIED') as product_tier,
         count(distinct l.email_key)::bigint as buyers,
         count(*) filter (where l.is_new_sale)::bigint as sales,
         coalesce(sum(l.amount_received), 0)::numeric as collected,
         case when count(*) filter (where l.is_new_sale) > 0
              then round(coalesce(sum(l.amount_received), 0) / count(*) filter (where l.is_new_sale), 2)
         end as avg_ticket,
         min(l.business_date) as first_date,
         max(l.business_date) as last_date
    from ledger_inflow l
   where (p_start is null or l.business_date >= p_start)
     and (p_end is null or l.business_date <= p_end)
   group by 1
   order by collected desc;
$$;

revoke execute on function public.ledger_tier_summary(date, date) from anon, public;
grant execute on function public.ledger_tier_summary(date, date) to authenticated, service_role;

create or replace function public.measured_ascension()
returns table (
  l1_buyers bigint,
  ascended_buyers bigint,
  ascension_pct numeric,
  l3_avg_ticket numeric,
  l1_avg_ticket numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with l1 as (
    select distinct email_key from ledger_inflow
     where product_tier = 'L1_SILVER' and email_key is not null
  ),
  l3 as (
    select distinct email_key from ledger_inflow
     where product_tier in ('L3_DIAMOND','L4') and email_key is not null
  ),
  tickets as (
    select
      (select round(sum(amount_received) / nullif(count(*) filter (where is_new_sale), 0), 2)
         from ledger_inflow where product_tier = 'L3_DIAMOND') as l3_avg,
      (select round(sum(amount_received) / nullif(count(*) filter (where is_new_sale), 0), 2)
         from ledger_inflow where product_tier = 'L1_SILVER') as l1_avg
  )
  select (select count(*) from l1)::bigint,
         (select count(*) from l1 join l3 using (email_key))::bigint,
         case when (select count(*) from l1) > 0
              then round((select count(*) from l1 join l3 using (email_key))::numeric * 100
                         / (select count(*) from l1), 2) end,
         t.l3_avg,
         t.l1_avg
    from tickets t;
$$;

revoke execute on function public.measured_ascension() from anon, public;
grant execute on function public.measured_ascension() to authenticated, service_role;
