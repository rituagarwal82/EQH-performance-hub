CREATE OR REPLACE FUNCTION public.ledger_reconciliation(p_year integer DEFAULT 2026, p_tier text DEFAULT 'L1_SILVER'::text, p_end date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with base as (
    select * from public.ledger_inflow
    where product_tier = p_tier
      and payment_date >= make_date(p_year, 1, 1)
      and payment_date <  make_date(p_year + 1, 1, 1)
      and (p_end is null or payment_date <= p_end)
  )
  select jsonb_build_object(
    'rows', (select count(*) from base),
    'emails', (select count(distinct lower(btrim(email_raw))) from base where coalesce(btrim(email_raw),'') <> ''),
    'sales', (select count(*) from base where is_new_sale),
    'collected', (select coalesce(sum(amount_received), 0) from base),
    'pending', (select coalesce(sum(amount_pending), 0) from base),
    'monthly', (select coalesce(jsonb_object_agg(m, n), '{}'::jsonb) from (
        select to_char(payment_date, 'Mon') as m, count(*) filter (where is_new_sale) as n
        from base group by 1
      ) x),
    'rails', (select coalesce(jsonb_object_agg(rail, pct), '{}'::jsonb) from (
        select coalesce(nullif(btrim(receipt_source), ''), 'Unknown') as rail,
               round(100.0 * sum(amount_received) / nullif((select sum(amount_received) from base), 0), 1) as pct
        from base group by 1
      ) y)
  )
$function$;

REVOKE EXECUTE ON FUNCTION public.ledger_reconciliation(integer, text, date) FROM anon, public, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_reconciliation(integer, text, date) TO service_role;