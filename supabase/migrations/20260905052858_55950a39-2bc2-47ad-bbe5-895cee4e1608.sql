-- Paid-attributed L1 collections, day by day.
--
-- Three contaminations are separated out rather than netted away, so the screen
-- can show what was removed and why:
--   * cash from buyers with no lead record at all (podcast, organic, referral)
--   * instalment cash from sales first made in an earlier month
--   * GST: ledger amount_received is gross, Meta spend is ex-GST
CREATE OR REPLACE FUNCTION public.ledger_paid_daily(p_start date, p_end date)
 RETURNS TABLE(
   business_date date,
   collected_all numeric,
   collected_new_sale numeric,
   collected_no_lead numeric,
   collected_instalment numeric,
   collected_paid_gross numeric,
   collected_paid_exgst numeric,
   rows_all bigint,
   rows_paid bigint
 )
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH l AS (
    SELECT li.business_date,
           li.amount_received,
           li.is_new_sale,
           EXISTS (SELECT 1 FROM public.leads x WHERE x.email_key = li.email_key) AS has_lead,
           -- A paid marker today is any UTM source on the lead; once name-based
           -- ad matching lands this tightens to ad_entity_ref.
           EXISTS (
             SELECT 1 FROM public.leads x
              WHERE x.email_key = li.email_key
                AND (x.ad_entity_ref IS NOT NULL OR x.utm_source IS NOT NULL)
           ) AS has_paid_marker
      FROM public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND li.email_key IS NOT NULL
    UNION ALL
    SELECT li.business_date, li.amount_received, li.is_new_sale, false, false
      FROM public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND li.email_key IS NULL
  )
  SELECT l.business_date,
         coalesce(sum(l.amount_received), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.is_new_sale), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.is_new_sale AND NOT l.has_lead), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE NOT l.is_new_sale), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.is_new_sale AND l.has_paid_marker), 0)::numeric,
         round(coalesce(sum(l.amount_received) FILTER (WHERE l.is_new_sale AND l.has_paid_marker), 0)::numeric / 1.18, 2),
         count(*)::bigint,
         count(*) FILTER (WHERE l.is_new_sale AND l.has_paid_marker)::bigint
    FROM l
   GROUP BY l.business_date
   ORDER BY l.business_date
$function$;

-- metric_series: front_end_roas is now the PAID, new-sale, ex-GST ratio.
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
      SUM(c.at_60) AS at_60,
      SUM(c.sales) AS sales,
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

-- The metric changed meaning, so its old bands and scored history describe a
-- different number. Clear both; the nightly rebuild refills the bands.
DELETE FROM public.metric_baselines WHERE metric_id = 'front_end_roas';
DELETE FROM public.verdict_history WHERE metric_id = 'front_end_roas';

CREATE OR REPLACE FUNCTION public.proof_summary()
 RETURNS TABLE(check_id text, label text, plain text, primary_source text, witness_source text, last_run timestamp with time zone, hours_since numeric, days_checked integer, matches integer, tolerable integer, diverged integer, unavailable integer, worst_date date, worst_divergence numeric, worst_primary numeric, worst_witness numeric, worst_note text, status text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH reg(check_id, label, plain, ord) AS (
    VALUES
      ('meta_spend', 'Meta spend', 'What we stored for each day against a fresh call to Meta''s own API for that day.', 1),
      ('sales_count', 'Sales count', 'TagMango enrolments against the accounts ledger''s New Sale count, on settled days only.', 2),
      ('registrations', 'Registrations', 'Registered leads in the CRM against registrants recorded by the webinar platform.', 3),
      ('attendance_integrity', 'Attendance arithmetic', 'Our own two ways of counting the same Zoom attendance, to catch aggregation bugs.', 4),
      ('ledger_closed_months', 'Closed months', 'The agreed January–July sale counts, re-asserted against the ledger every day.', 5),
      ('attribution_purity', 'Attribution purity', 'Ad-attributed collections against total collections: the first can never exceed the second, and the two converging means attribution has stopped discriminating.', 6)
  ),
  last AS (
    SELECT r.check_id, max(r.checked_at) AS last_run
      FROM public.reconciliations r GROUP BY r.check_id
  ),
  cur AS (
    SELECT r.*
      FROM public.reconciliations r
      JOIN last ON last.check_id = r.check_id
     WHERE r.checked_at > last.last_run - interval '2 hours'
  ),
  agg AS (
    SELECT c.check_id,
           count(*)::int AS days_checked,
           count(*) FILTER (WHERE c.verdict = 'match')::int AS matches,
           count(*) FILTER (WHERE c.verdict = 'tolerable')::int AS tolerable,
           count(*) FILTER (WHERE c.verdict = 'diverged')::int AS diverged,
           count(*) FILTER (WHERE c.verdict = 'witness_unavailable')::int AS unavailable,
           (array_agg(c.primary_source ORDER BY c.for_date DESC))[1] AS primary_source,
           (array_agg(c.witness_source ORDER BY c.for_date DESC))[1] AS witness_source
      FROM cur c GROUP BY c.check_id
  ),
  worst AS (
    SELECT DISTINCT ON (c.check_id)
           c.check_id, c.for_date, c.divergence_pct, c.primary_value, c.witness_value, c.note
      FROM cur c
     ORDER BY c.check_id, abs(coalesce(c.divergence_pct, 0)) DESC, c.for_date DESC
  )
  SELECT reg.check_id,
         reg.label,
         reg.plain,
         agg.primary_source,
         agg.witness_source,
         last.last_run,
         CASE WHEN last.last_run IS NULL THEN NULL
              ELSE round(extract(epoch FROM (now() - last.last_run)) / 3600.0, 2) END,
         coalesce(agg.days_checked, 0),
         coalesce(agg.matches, 0),
         coalesce(agg.tolerable, 0),
         coalesce(agg.diverged, 0),
         coalesce(agg.unavailable, 0),
         worst.for_date,
         worst.divergence_pct,
         worst.primary_value,
         worst.witness_value,
         worst.note,
         CASE
           WHEN last.last_run IS NULL THEN 'never_run'
           WHEN extract(epoch FROM (now() - last.last_run)) / 3600.0 > 48 THEN 'stale'
           WHEN coalesce(agg.diverged, 0) > 0 THEN 'diverged'
           WHEN coalesce(agg.matches, 0) + coalesce(agg.tolerable, 0) = 0 THEN 'unverified'
           ELSE 'match'
         END
    FROM reg
    LEFT JOIN last ON last.check_id = reg.check_id
    LEFT JOIN agg  ON agg.check_id  = reg.check_id
    LEFT JOIN worst ON worst.check_id = reg.check_id
   ORDER BY reg.ord
$function$;

REVOKE ALL ON FUNCTION public.ledger_paid_daily(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ledger_paid_daily(date, date) TO authenticated, service_role;