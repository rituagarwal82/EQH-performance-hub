CREATE OR REPLACE FUNCTION public.cohort_backend_return(p_from date DEFAULT '2024-01-01', p_to date DEFAULT NULL)
RETURNS TABLE(
  cohort_month date,
  buyers bigint,
  matched_buyers bigint,
  paid_buyers bigint,
  coverage_pct numeric,
  spend numeric,
  spend_basis text,
  front_d30 numeric, back_d30 numeric,
  front_d60 numeric, back_d60 numeric,
  front_d90 numeric, back_d90 numeric,
  front_d180 numeric, back_d180 numeric,
  front_d365 numeric, back_d365 numeric,
  front_life numeric, back_life numeric,
  total_life numeric,
  per_buyer_life numeric,
  roas_d30 numeric, roas_d90 numeric, roas_d180 numeric, roas_d365 numeric, roas_life numeric,
  breakeven_month integer,
  months_elapsed integer,
  maturing boolean
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '120s'
AS $function$
  WITH first_buy AS (
    SELECT li.email_key,
           min(li.business_date) AS first_date
      FROM public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER' AND li.counts_as_sale
       AND li.email_key IS NOT NULL AND li.email_key <> ''
     GROUP BY 1
  ),
  b AS (
    SELECT f.email_key,
           f.first_date,
           date_trunc('month', f.first_date)::date AS cm,
           EXISTS (SELECT 1 FROM public.buyer_lead_link k WHERE k.email_key = f.email_key) AS matched,
           EXISTS (
             SELECT 1 FROM public.buyer_lead_link k
               JOIN public.lead_attribution_mv la ON la.email_key = k.lead_email_key
              WHERE k.email_key = f.email_key AND la.is_paid
                AND lower(la.platform) IN ('meta','facebook')
           ) AS paid
      FROM first_buy f
     WHERE f.first_date >= date_trunc('month', p_from)::date
       AND f.first_date <= COALESCE(p_to, public.business_date(now()))
  ),
  cash AS (
    SELECT b.cm,
           b.paid,
           (c.business_date - b.first_date) AS age,
           (c.product_tier = 'L1_SILVER') AS is_front,
           c.amount_received AS amt
      FROM b
      JOIN public.ledger_inflow c ON c.email_key = b.email_key
     WHERE c.amount_received IS NOT NULL
  ),
  agg AS (
    SELECT cm,
           sum(amt) FILTER (WHERE paid AND is_front AND age <= 30) AS f30,
           sum(amt) FILTER (WHERE paid AND NOT is_front AND age <= 30) AS bk30,
           sum(amt) FILTER (WHERE paid AND is_front AND age <= 60) AS f60,
           sum(amt) FILTER (WHERE paid AND NOT is_front AND age <= 60) AS bk60,
           sum(amt) FILTER (WHERE paid AND is_front AND age <= 90) AS f90,
           sum(amt) FILTER (WHERE paid AND NOT is_front AND age <= 90) AS bk90,
           sum(amt) FILTER (WHERE paid AND is_front AND age <= 180) AS f180,
           sum(amt) FILTER (WHERE paid AND NOT is_front AND age <= 180) AS bk180,
           sum(amt) FILTER (WHERE paid AND is_front AND age <= 365) AS f365,
           sum(amt) FILTER (WHERE paid AND NOT is_front AND age <= 365) AS bk365,
           sum(amt) FILTER (WHERE paid AND is_front) AS flife,
           sum(amt) FILTER (WHERE paid AND NOT is_front) AS bklife,
           sum(amt) AS all_life
      FROM cash GROUP BY 1
  ),
  people AS (
    SELECT cm,
           count(*)::bigint AS n,
           count(*) FILTER (WHERE matched)::bigint AS n_matched,
           count(*) FILTER (WHERE paid)::bigint AS n_paid
      FROM b GROUP BY 1
  ),
  sp AS (
    SELECT date_trunc('month', m.date)::date AS cm, sum(m.spend)::numeric AS spend
      FROM public.daily_metrics m WHERE m.level = 'account' GROUP BY 1
  ),
  base AS (
    SELECT p.cm,
           p.n, p.n_matched, p.n_paid,
           s.spend,
           CASE WHEN s.spend IS NULL OR s.spend = 0 THEN 'none'
                WHEN p.cm < '2026-08-01'::date THEN 'sx_regime'
                ELSE 'measured' END AS basis,
           COALESCE(a.f30,0) f30, COALESCE(a.bk30,0) bk30,
           COALESCE(a.f60,0) f60, COALESCE(a.bk60,0) bk60,
           COALESCE(a.f90,0) f90, COALESCE(a.bk90,0) bk90,
           COALESCE(a.f180,0) f180, COALESCE(a.bk180,0) bk180,
           COALESCE(a.f365,0) f365, COALESCE(a.bk365,0) bk365,
           COALESCE(a.flife,0) flife, COALESCE(a.bklife,0) bklife,
           COALESCE(a.all_life,0) all_life
      FROM people p
      LEFT JOIN agg a ON a.cm = p.cm
      LEFT JOIN sp s ON s.cm = p.cm
  ),
  be AS (
    SELECT base.cm,
           (SELECT min(g.i) FROM generate_series(0, 36) g(i)
             WHERE base.spend IS NOT NULL AND base.spend > 0
               AND (SELECT COALESCE(sum(c.amt),0) FROM cash c
                     WHERE c.cm = base.cm AND c.paid AND c.age <= (g.i + 1) * 30) >= base.spend
           ) + 1 AS be_month
      FROM base
  )
  SELECT base.cm,
         base.n, base.n_matched, base.n_paid,
         CASE WHEN base.n > 0 THEN round(base.n_matched::numeric * 100 / base.n, 1) END,
         base.spend,
         base.basis,
         base.f30, base.bk30, base.f60, base.bk60, base.f90, base.bk90,
         base.f180, base.bk180, base.f365, base.bk365,
         base.flife, base.bklife,
         base.all_life,
         CASE WHEN base.n > 0 THEN round(base.all_life / base.n, 2) END,
         CASE WHEN base.basis <> 'none' THEN round((base.f30 + base.bk30) / base.spend, 3) END,
         CASE WHEN base.basis <> 'none' THEN round((base.f90 + base.bk90) / base.spend, 3) END,
         CASE WHEN base.basis <> 'none' THEN round((base.f180 + base.bk180) / base.spend, 3) END,
         CASE WHEN base.basis <> 'none' THEN round((base.f365 + base.bk365) / base.spend, 3) END,
         CASE WHEN base.basis <> 'none' THEN round((base.flife + base.bklife) / base.spend, 3) END,
         be.be_month,
         (((EXTRACT(year FROM public.business_date(now())) - EXTRACT(year FROM base.cm)) * 12)
          + (EXTRACT(month FROM public.business_date(now())) - EXTRACT(month FROM base.cm)))::int,
         (((EXTRACT(year FROM public.business_date(now())) - EXTRACT(year FROM base.cm)) * 12)
          + (EXTRACT(month FROM public.business_date(now())) - EXTRACT(month FROM base.cm))) < 12
    FROM base LEFT JOIN be ON be.cm = base.cm
   ORDER BY base.cm
$function$;

REVOKE ALL ON FUNCTION public.cohort_backend_return(date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.cohort_backend_return(date, date) TO service_role;