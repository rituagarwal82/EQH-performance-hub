-- N2: cost_per_sale contract v3 says TOTAL Meta account spend. metric_series
-- implemented measured spend, so the verdict card and /sales gave different
-- answers for the same month (July: 7,171.92 vs 11,392.00) and produced
-- opposite month-on-month conclusions. One definition now: total spend.
CREATE OR REPLACE FUNCTION public.metric_series(p_start date, p_end date, p_grain text DEFAULT 'day'::text)
 RETURNS TABLE(period_start date, metric_id text, value numeric, denom numeric, rupees numeric, complete boolean, days bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH c AS (SELECT * FROM public.metric_components(p_start, p_end)),
  pd AS (SELECT * FROM public.ledger_paid_daily(p_start, p_end)),
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
      SUM(c.attendees_matched) AS attendees_matched,
      SUM(c.sessions_without_registrants) AS sessions_excluded,
      SUM(c.at_60) AS at_60,
      SUM(c.sales) AS sales,
      SUM(c.paid_sales) AS paid_sales,
      SUM(c.collected) AS collected,
      SUM(pd.collected_paid_exgst) AS paid_exgst,
      bool_and(c.has_meta) AS all_meta,
      bool_and(c.has_ledger) AS all_ledger,
      bool_and(c.has_tm) AS all_tm,
      bool_or(c.ledger_settling) AS any_settling,
      bool_or(c.has_zoom) AS any_zoom
    FROM c LEFT JOIN pd ON pd.business_date = c.date GROUP BY 1
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
           CASE WHEN COALESCE(b.registrants,0) > 0 THEN 100.0 * b.attendees_matched / b.registrants END,
           b.registrants::numeric, COALESCE(b.spend,0),
           (b.any_zoom AND COALESCE(b.sessions_excluded,0) = 0), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'retention_60',
           CASE WHEN COALESCE(b.attendees,0) > 0 THEN 100.0 * b.at_60 / b.attendees END,
           b.attendees::numeric, COALESCE(b.spend,0), b.any_zoom, b.days FROM b
    UNION ALL
    SELECT b.period_start, 'sales_per_1000_leads',
           CASE WHEN COALESCE(b.registrations,0) > 0 THEN 1000.0 * b.paid_sales / b.registrations END,
           b.registrations::numeric, COALESCE(b.collected,0), (b.all_meta AND b.all_tm), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'cost_per_sale',
           CASE WHEN COALESCE(b.paid_sales,0) > 0 THEN b.spend / b.paid_sales END,
           b.paid_sales::numeric, COALESCE(b.spend,0), (b.all_meta AND b.all_tm), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'front_end_roas',
           CASE WHEN COALESCE(b.spend,0) > 0 THEN b.paid_exgst / b.spend END,
           NULL, COALESCE(b.paid_exgst,0) + COALESCE(b.spend,0),
           (b.all_meta AND b.all_ledger AND NOT b.any_settling), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'paid_collected_exgst', b.paid_exgst, NULL,
           COALESCE(b.paid_exgst,0), (b.all_ledger AND NOT b.any_settling), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'collected', b.collected, NULL,
           COALESCE(b.collected,0), (b.all_ledger AND NOT b.any_settling), b.days FROM b
  ) x
  ORDER BY 2, 1
$function$;

-- The written definition did not change; the code was brought to it. Record a
-- rule change so the correction is visible in the audit trail.
INSERT INTO public.rule_changes (rule_key, what_changed, old_rule, new_rule, reason, confirmed_by, affects, evidence)
VALUES (
  'cost_per_sale_spend_basis',
  'Cost per sale on the daily verdict card now uses total Meta spend, matching contract v3 and the sales screen.',
  'metric_series divided measured-account spend by paid-attributed sales.',
  'metric_series divides total Meta account spend by paid-attributed sales.',
  'Two screens gave different answers for the same month and produced opposite month-on-month conclusions (July 7,171.92 vs 11,392.00).',
  'owner audit N2',
  ARRAY['cost_per_sale'],
  '{"july_verdict_before": 7171.92, "july_sales_screen": 11392.00, "golden": 11475.07}'::jsonb
);