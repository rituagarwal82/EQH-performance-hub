DROP FUNCTION IF EXISTS public.metric_series(date, date, text);
DROP FUNCTION IF EXISTS public.metric_components(date, date);

CREATE OR REPLACE FUNCTION public.metric_components(p_start date, p_end date)
 RETURNS TABLE(date date, spend numeric, measured_spend numeric, registrations bigint, registrants bigint, attendees bigint, at_60 bigint, sales bigint, collected numeric, has_meta boolean, has_zoom boolean, has_ledger boolean, tm_sales bigint, ledger_sales bigint, has_tm boolean, ledger_settling boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
  led AS (
    SELECT l.business_date AS date,
           count(*) FILTER (WHERE l.is_new_sale)::bigint AS sales,
           SUM(l.amount_received)::numeric AS collected,
           count(*)::bigint AS rows_n
    FROM public.ledger_inflow l
    WHERE l.product_tier = 'L1_SILVER' AND l.business_date BETWEEN p_start AND p_end
    GROUP BY l.business_date
  )
  SELECT d.date,
         meta.spend, meta.measured_spend, meta.registrations,
         zoom.registrants, zoom.attendees, zoom.at_60,
         tm.sales AS sales,
         led.collected,
         COALESCE(meta.rows_n, 0) > 0,
         COALESCE(zoom.rows_n, 0) > 0,
         COALESCE(led.rows_n, 0) > 0,
         tm.sales AS tm_sales,
         led.sales AS ledger_sales,
         COALESCE(tm.rows_n, 0) > 0 AS has_tm,
         -- A ledger day is settling until three days have passed OR its own new-sale
         -- count is within 20% of the TagMango enrolment count for that date.
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
  ORDER BY d.date
$function$;

CREATE OR REPLACE FUNCTION public.metric_series(p_start date, p_end date, p_grain text DEFAULT 'day'::text)
 RETURNS TABLE(period_start date, metric_id text, value numeric, denom numeric, rupees numeric, complete boolean, days bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH c AS (SELECT * FROM public.metric_components(p_start, p_end)),
  b AS (
    SELECT
      CASE p_grain
        WHEN 'week'  THEN date_trunc('week',  c.date)::date
        WHEN 'month' THEN date_trunc('month', c.date)::date
        ELSE c.date
      END AS period_start,
      count(*)::bigint AS days,
      SUM(c.spend) AS spend,
      SUM(c.measured_spend) AS measured_spend,
      SUM(c.registrations) AS registrations,
      SUM(c.registrants) AS registrants,
      SUM(c.attendees) AS attendees,
      SUM(c.at_60) AS at_60,
      SUM(c.sales) AS sales,
      SUM(c.collected) AS collected,
      bool_and(c.has_meta) AS all_meta,
      bool_and(c.has_ledger) AS all_ledger,
      bool_and(c.has_tm) AS all_tm,
      bool_or(c.ledger_settling) AS any_settling,
      bool_or(c.has_zoom) AS any_zoom
    FROM c GROUP BY 1
  )
  SELECT * FROM (
    SELECT b.period_start, 'meta_spend'::text, b.spend, NULL::numeric,
           COALESCE(b.spend,0), b.all_meta, b.days FROM b
    UNION ALL
    SELECT b.period_start, 'registrations', b.registrations::numeric, NULL,
           COALESCE(b.measured_spend,0), b.all_meta, b.days FROM b
    UNION ALL
    SELECT b.period_start, 'cost_per_registration',
           CASE WHEN COALESCE(b.registrations,0) > 0 THEN b.measured_spend / b.registrations END,
           b.registrations::numeric, COALESCE(b.measured_spend,0), b.all_meta, b.days FROM b
    UNION ALL
    SELECT b.period_start, 'show_up_rate',
           CASE WHEN COALESCE(b.registrants,0) > 0 THEN 100.0 * b.attendees / b.registrants END,
           b.registrants::numeric, COALESCE(b.spend,0), b.any_zoom, b.days FROM b
    UNION ALL
    SELECT b.period_start, 'retention_60',
           CASE WHEN COALESCE(b.attendees,0) > 0 THEN 100.0 * b.at_60 / b.attendees END,
           b.attendees::numeric, COALESCE(b.spend,0), b.any_zoom, b.days FROM b
    UNION ALL
    SELECT b.period_start, 'sales_per_1000_leads',
           CASE WHEN COALESCE(b.registrations,0) > 0 THEN 1000.0 * b.sales / b.registrations END,
           b.registrations::numeric, COALESCE(b.collected,0), (b.all_meta AND b.all_tm), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'cost_per_sale',
           CASE WHEN COALESCE(b.sales,0) > 0 THEN b.spend / b.sales END,
           b.sales::numeric, COALESCE(b.spend,0), (b.all_meta AND b.all_tm), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'front_end_roas',
           CASE WHEN COALESCE(b.spend,0) > 0 THEN b.collected / b.spend END,
           NULL, COALESCE(b.collected,0) + COALESCE(b.spend,0),
           (b.all_meta AND b.all_ledger AND NOT b.any_settling), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'collected', b.collected, NULL,
           COALESCE(b.collected,0), (b.all_ledger AND NOT b.any_settling), b.days FROM b
  ) x
  ORDER BY 2, 1
$function$;

CREATE OR REPLACE FUNCTION public.sales_reconciliation(p_start date, p_end date)
 RETURNS TABLE(date date, tm_sales bigint, ledger_sales bigint, collected numeric, settling boolean, divergence_pct numeric, review boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH c AS (SELECT * FROM public.metric_components(p_start, p_end))
  SELECT c.date,
         c.tm_sales,
         c.ledger_sales,
         c.collected,
         c.ledger_settling,
         CASE WHEN COALESCE(c.tm_sales,0) > 0
              THEN round(100.0 * (COALESCE(c.ledger_sales,0) - c.tm_sales)::numeric / c.tm_sales, 1)
         END AS divergence_pct,
         (
           NOT c.ledger_settling
           AND COALESCE(c.tm_sales,0) > 0
           AND abs(COALESCE(c.ledger_sales,0) - c.tm_sales)::numeric > 0.2 * c.tm_sales
         ) AS review
  FROM c
  ORDER BY c.date DESC
$function$;