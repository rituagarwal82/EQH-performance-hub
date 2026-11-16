-- ============ components per day ============
CREATE OR REPLACE FUNCTION public.metric_components(p_start date, p_end date)
RETURNS TABLE(
  date date,
  spend numeric, measured_spend numeric, registrations bigint,
  registrants bigint, attendees bigint, at_60 bigint,
  sales bigint, collected numeric,
  has_meta boolean, has_zoom boolean, has_ledger boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
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
         led.sales, led.collected,
         COALESCE(meta.rows_n, 0) > 0,
         COALESCE(zoom.rows_n, 0) > 0,
         COALESCE(led.rows_n, 0) > 0
  FROM d
  LEFT JOIN meta ON meta.date = d.date
  LEFT JOIN zoom ON zoom.date = d.date
  LEFT JOIN led  ON led.date  = d.date
  ORDER BY d.date
$$;

-- ============ nine measures, any grain ============
CREATE OR REPLACE FUNCTION public.metric_series(p_start date, p_end date, p_grain text DEFAULT 'day')
RETURNS TABLE(
  period_start date, metric_id text, value numeric,
  denom numeric, rupees numeric, complete boolean, days bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
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
           b.registrations::numeric, COALESCE(b.collected,0), (b.all_meta AND b.all_ledger), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'cost_per_sale',
           CASE WHEN COALESCE(b.sales,0) > 0 THEN b.spend / b.sales END,
           b.sales::numeric, COALESCE(b.spend,0), (b.all_meta AND b.all_ledger), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'front_end_roas',
           CASE WHEN COALESCE(b.spend,0) > 0 THEN b.collected / b.spend END,
           NULL, COALESCE(b.collected,0) + COALESCE(b.spend,0), (b.all_meta AND b.all_ledger), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'collected', b.collected, NULL,
           COALESCE(b.collected,0), b.all_ledger, b.days FROM b
  ) x
  ORDER BY 2, 1
$$;

-- ============ baselines ============
CREATE TABLE IF NOT EXISTS public.metric_baselines (
  metric_id text NOT NULL,
  grain text NOT NULL,
  weekday_class text NOT NULL,
  median numeric,
  mad numeric,
  n_observations int NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_id, grain, weekday_class)
);

GRANT SELECT ON public.metric_baselines TO authenticated;
GRANT ALL ON public.metric_baselines TO service_role;
ALTER TABLE public.metric_baselines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read metric_baselines"
  ON public.metric_baselines FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages metric_baselines"
  ON public.metric_baselines FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.verdict_history (
  date date NOT NULL,
  metric_id text NOT NULL,
  z numeric NOT NULL,
  rupees numeric NOT NULL DEFAULT 0,
  rank numeric NOT NULL DEFAULT 0,
  position int NOT NULL,
  value numeric,
  baseline numeric,
  direction text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, metric_id)
);

GRANT SELECT ON public.verdict_history TO authenticated;
GRANT ALL ON public.verdict_history TO service_role;
ALTER TABLE public.verdict_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read verdict_history"
  ON public.verdict_history FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages verdict_history"
  ON public.verdict_history FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============ nightly baseline rebuild ============
CREATE OR REPLACE FUNCTION public.rebuild_metric_baselines(p_asof date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_end date := COALESCE(p_asof, current_date - 1);
  v_count integer := 0;
BEGIN
  -- day grain: trailing 28 days, split weekday / weekend
  WITH s AS (
    SELECT m.period_start, m.metric_id, m.value,
           CASE WHEN extract(isodow FROM m.period_start) >= 6 THEN 'weekend' ELSE 'weekday' END AS wc
    FROM public.metric_series(v_end - 27, v_end, 'day') m
    WHERE m.value IS NOT NULL AND m.complete
  ), med AS (
    SELECT metric_id, wc,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS median,
           count(*)::int AS n
    FROM s GROUP BY 1,2
  ), dev AS (
    SELECT s.metric_id, s.wc,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(s.value - med.median)) AS mad
    FROM s JOIN med ON med.metric_id = s.metric_id AND med.wc = s.wc
    GROUP BY 1,2
  ), up AS (
    INSERT INTO public.metric_baselines (metric_id, grain, weekday_class, median, mad, n_observations, computed_at)
    SELECT med.metric_id, 'day', med.wc, med.median, dev.mad, med.n, now()
    FROM med JOIN dev ON dev.metric_id = med.metric_id AND dev.wc = med.wc
    ON CONFLICT (metric_id, grain, weekday_class) DO UPDATE SET
      median = excluded.median, mad = excluded.mad,
      n_observations = excluded.n_observations, computed_at = now()
    RETURNING 1
  ) SELECT count(*) INTO v_count FROM up;

  -- week grain: trailing 12 complete weeks
  WITH s AS (
    SELECT m.metric_id, m.value
    FROM public.metric_series(date_trunc('week', v_end)::date - 84, date_trunc('week', v_end)::date - 1, 'week') m
    WHERE m.value IS NOT NULL AND m.complete AND m.days = 7
  ), med AS (
    SELECT metric_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS median, count(*)::int AS n
    FROM s GROUP BY 1
  ), dev AS (
    SELECT s.metric_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(s.value - med.median)) AS mad
    FROM s JOIN med ON med.metric_id = s.metric_id GROUP BY 1
  )
  INSERT INTO public.metric_baselines (metric_id, grain, weekday_class, median, mad, n_observations, computed_at)
  SELECT med.metric_id, 'week', 'all', med.median, dev.mad, med.n, now()
  FROM med JOIN dev ON dev.metric_id = med.metric_id
  ON CONFLICT (metric_id, grain, weekday_class) DO UPDATE SET
    median = excluded.median, mad = excluded.mad,
    n_observations = excluded.n_observations, computed_at = now();

  -- month grain: trailing 12 complete months
  WITH s AS (
    SELECT m.metric_id, m.value
    FROM public.metric_series((date_trunc('month', v_end) - interval '12 months')::date,
                              (date_trunc('month', v_end) - interval '1 day')::date, 'month') m
    WHERE m.value IS NOT NULL AND m.complete
  ), med AS (
    SELECT metric_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS median, count(*)::int AS n
    FROM s GROUP BY 1
  ), dev AS (
    SELECT s.metric_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(s.value - med.median)) AS mad
    FROM s JOIN med ON med.metric_id = s.metric_id GROUP BY 1
  )
  INSERT INTO public.metric_baselines (metric_id, grain, weekday_class, median, mad, n_observations, computed_at)
  SELECT med.metric_id, 'month', 'all', med.median, dev.mad, med.n, now()
  FROM med JOIN dev ON dev.metric_id = med.metric_id
  ON CONFLICT (metric_id, grain, weekday_class) DO UPDATE SET
    median = excluded.median, mad = excluded.mad,
    n_observations = excluded.n_observations, computed_at = now();

  RETURN v_count;
END $$;

REVOKE EXECUTE ON FUNCTION public.metric_components(date, date) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.metric_series(date, date, text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.rebuild_metric_baselines(date) FROM anon, public;
