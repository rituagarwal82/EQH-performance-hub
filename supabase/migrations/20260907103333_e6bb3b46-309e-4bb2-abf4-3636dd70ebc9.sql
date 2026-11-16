-- V2(b): ONE implementation of "paid-attributed L1 new sale". The screen path
-- (metric_components) and the certification path (golden_paid_l1_sales) both
-- call this from now on, so the harness can never again certify a calculation
-- no screen uses.
CREATE OR REPLACE FUNCTION public.paid_l1_new_sales_by_day(p_start date, p_end date)
 RETURNS TABLE(business_date date, paid_sales bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT l.business_date,
         count(*) FILTER (
           WHERE l.counts_as_sale AND EXISTS (
             SELECT 1
               FROM public.buyer_lead_link k
               JOIN public.lead_attribution_mv la ON la.email_key = k.lead_email_key
              WHERE k.email_key = l.email_key
                AND la.is_paid
                AND public.agency_spend_synced(la.agency_code)
           )
         )::bigint
    FROM public.ledger_inflow l
   WHERE l.product_tier = 'L1_SILVER' AND l.business_date BETWEEN p_start AND p_end
   GROUP BY l.business_date;
$function$;

REVOKE EXECUTE ON FUNCTION public.paid_l1_new_sales_by_day(date, date) FROM public, anon, authenticated;

-- The golden is now a thin sum over the same rule the screens use.
CREATE OR REPLACE FUNCTION public.golden_paid_l1_sales(p_start date, p_end date)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(paid_sales), 0)::numeric
    FROM public.paid_l1_new_sales_by_day(p_start, p_end);
$function$;

-- metric_components reads the same function instead of repeating the rule.
CREATE OR REPLACE FUNCTION public.metric_components(p_start date, p_end date)
 RETURNS TABLE(date date, spend numeric, measured_spend numeric, registrations bigint, registrants bigint, attendees bigint, attendees_matched bigint, sessions_without_registrants bigint, at_60 bigint, sales bigint, paid_sales bigint, collected numeric, has_meta boolean, has_zoom boolean, has_ledger boolean, tm_sales bigint, ledger_sales bigint, has_tm boolean, ledger_settling boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
  WITH d AS (
    SELECT g::date AS date
    FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
  ),
  meta AS (
    SELECT m.date,
           SUM(m.spend)::numeric AS spend,
           SUM(m.spend) FILTER (WHERE a.lead_tracking_status = 'working')::numeric AS measured_spend,
           SUM(m.leads) FILTER (WHERE a.lead_tracking_status = 'working')::bigint AS registrations,
           count(*)::bigint AS rows_n
    FROM public.daily_metrics m
    JOIN public.ad_accounts a ON a.account_id = m.account_id
    WHERE m.level = 'account' AND m.date BETWEEN p_start AND p_end
    GROUP BY m.date
  ),
  zoom AS (
    SELECT z.event_date AS date,
           SUM(z.registrants)::bigint AS registrants,
           SUM(z.attendees)::bigint AS attendees,
           SUM(z.attendees_matched)::bigint AS attendees_matched,
           SUM(z.sessions_without_registrants)::bigint AS sessions_without_registrants,
           SUM(z.at_60)::bigint AS at_60,
           count(*)::bigint AS rows_n
    FROM public.zoom_event_rows(p_start, p_end, false) z
    GROUP BY z.event_date
  ),
  tm AS (
    SELECT e.business_date AS date,
           count(DISTINCT e.person_key)::bigint AS sales,
           count(*)::bigint AS rows_n
    FROM public.tm_enrolments e
    JOIN public.products p ON p.mango_id = e.mango_id AND p.counts_as_sale
    WHERE e.business_date BETWEEN p_start AND p_end
    GROUP BY e.business_date
  ),
  paid AS (
    SELECT * FROM public.paid_l1_new_sales_by_day(p_start, p_end)
  ),
  led AS (
    SELECT l.business_date AS date,
           count(*) FILTER (WHERE l.counts_as_sale)::bigint AS sales,
           SUM(l.amount_received)::numeric AS collected,
           count(*)::bigint AS rows_n
    FROM public.ledger_inflow l
    WHERE l.product_tier = 'L1_SILVER' AND l.business_date BETWEEN p_start AND p_end
    GROUP BY l.business_date
  )
  SELECT d.date,
         meta.spend, meta.measured_spend, meta.registrations,
         zoom.registrants, zoom.attendees, zoom.attendees_matched,
         COALESCE(zoom.sessions_without_registrants, 0),
         zoom.at_60,
         led.sales, paid.paid_sales,
         led.collected,
         COALESCE(meta.rows_n, 0) > 0,
         COALESCE(zoom.rows_n, 0) > 0,
         COALESCE(led.rows_n, 0) > 0,
         tm.sales, led.sales,
         COALESCE(tm.rows_n, 0) > 0,
         (
           (public.business_date(now()) - d.date) < 3
           AND NOT (
             COALESCE(tm.sales, 0) > 0
             AND abs(COALESCE(led.sales, 0) - tm.sales)::numeric <= 0.2 * tm.sales
           )
         ) AS ledger_settling
  FROM d
  LEFT JOIN meta ON meta.date = d.date
  LEFT JOIN zoom ON zoom.date = d.date
  LEFT JOIN tm   ON tm.date   = d.date
  LEFT JOIN led  ON led.date  = d.date
  LEFT JOIN paid ON paid.business_date = d.date
  ORDER BY d.date
$function$;