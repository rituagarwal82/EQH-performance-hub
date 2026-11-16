-- A fast, L1-only count of first-course buyers whose sale found no
-- registration record, read from the stored attribution rather than
-- recomputed on every page load.
CREATE OR REPLACE FUNCTION public.nolead_owner_summary(p_since date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'buyers', count(distinct sa.email_key),
    'sales', count(*),
    'collected', coalesce(round(sum(sa.cash), 2), 0)
  )
  from public.sale_attribution sa
  join public.ledger_inflow li on li.row_hash = sa.row_hash
 where sa.channel = 'No lead record'
   and sa.is_new_sale
   and li.product_tier = 'L1_SILVER'
   and sa.business_date >= p_since
$function$;

GRANT EXECUTE ON FUNCTION public.nolead_owner_summary(date) TO authenticated, anon, service_role;