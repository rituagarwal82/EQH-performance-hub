-- One person, one index lookup. Reading the whole per-person view to answer
-- "was this buyer a paid lead?" stopped fitting the query time limit once the
-- CRM history was fully imported.
CREATE OR REPLACE FUNCTION public.lead_is_paid(p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (NOT l.is_import
          OR (l.webinar_date IS NOT NULL
              AND EXISTS (SELECT 1 FROM unnest(l.tags) t WHERE lower(t) = 'registered')))
     AND (COALESCE(m.is_paid, false)
          OR l.ad_id IS NOT NULL
          OR l.campaign_id IS NOT NULL
          OR lower(COALESCE(l.utm_medium,'')) = ANY (ARRAY['cpc','paid','ppc','paid_social']))
  FROM public.leads l
  LEFT JOIN public.utm_source_map m ON m.raw = lower(btrim(COALESCE(l.utm_source,'')))
  WHERE l.email_key = p_email AND p_email IS NOT NULL AND p_email <> ''
  ORDER BY l.captured_at
  LIMIT 1
$function$;

REVOKE ALL ON FUNCTION public.lead_is_paid(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_is_paid(text) TO service_role;

CREATE OR REPLACE FUNCTION public.measured_ascension()
 RETURNS TABLE(l1_buyers bigint, ascended_buyers bigint, ascension_pct numeric, l3_avg_ticket numeric, l1_avg_ticket numeric, cohort_start date, cohort_end date, buyers_per_1000 numeric, buyers_window_start date, buyers_window_end date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      (select round(sum(amount_received) / 1.18 / nullif(count(*) filter (where counts_as_sale), 0), 2)
         from ledger_inflow where product_tier = 'L3_DIAMOND') as l3_avg,
      (select round(sum(amount_received) / 1.18 / nullif(count(*) filter (where counts_as_sale), 0), 2)
         from ledger_inflow where product_tier = 'L1_SILVER') as l1_avg
  ),
  cohort as (
    select min(business_date) s, max(business_date) e from ledger_inflow where email_key is not null
  ),
  bw as (
    select (public.business_date(now()) - 30)::date s, (public.business_date(now()) - 1)::date e
  ),
  buyers as (
    select
      (select count(*) from ledger_inflow li
        where li.product_tier = 'L1_SILVER' and li.counts_as_sale
          and li.business_date between (select s from bw) and (select e from bw)
          and coalesce(public.lead_is_paid(li.email_key), false))::numeric as paid_sales,
      (select coalesce(sum(m.leads),0) from public.daily_metrics m
         join public.ad_accounts a on a.account_id = m.account_id
        where m.level = 'account' and a.lead_tracking_status = 'working'
          and m.date between (select s from bw) and (select e from bw))::numeric as regs
  )
  select (select count(*) from l1)::bigint,
         (select count(*) from l1 join l3 using (email_key))::bigint,
         case when (select count(*) from l1) > 0
              then round((select count(*) from l1 join l3 using (email_key))::numeric * 100
                         / (select count(*) from l1), 2) end,
         t.l3_avg, t.l1_avg,
         c.s, c.e,
         case when b.regs > 0 then round(1000 * b.paid_sales / b.regs, 2) end,
         (select s from bw), (select e from bw)
    from tickets t, cohort c, buyers b
$function$;