CREATE OR REPLACE FUNCTION public.recompute_seat_sales()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_dep int; v_comp int;
begin
  UPDATE public.ledger_inflow
     SET is_seat_deposit = (product_tier = 'L1_SILVER' AND payment_type = 'Booking Amount')
   WHERE is_seat_deposit <> (product_tier = 'L1_SILVER' AND payment_type = 'Booking Amount');

  UPDATE public.ledger_inflow
     SET seat_completed_at = NULL, seat_completion_of = NULL
   WHERE seat_completed_at IS NOT NULL OR seat_completion_of IS NOT NULL;

  WITH dep AS (
    SELECT row_hash, email_key, business_date,
           row_number() OVER (PARTITION BY email_key ORDER BY business_date, row_hash) AS rn
      FROM public.ledger_inflow
     WHERE is_seat_deposit AND email_key IS NOT NULL
  ), bal AS (
    SELECT row_hash, email_key, business_date,
           row_number() OVER (PARTITION BY email_key ORDER BY business_date, row_hash) AS rn
      FROM public.ledger_inflow
     WHERE product_tier = 'L1_SILVER' AND NOT is_seat_deposit AND email_key IS NOT NULL
       AND payment_type IN ('Final Payment','Full Payment','Instalment')
  ), pair AS (
    SELECT d.row_hash AS dep_hash, b.row_hash AS bal_hash, b.business_date AS completed_at
      FROM dep d
      JOIN bal b ON b.email_key = d.email_key AND b.rn = d.rn
     WHERE b.business_date >= d.business_date
  ), u1 AS (
    UPDATE public.ledger_inflow l SET seat_completed_at = p.completed_at
      FROM pair p WHERE l.row_hash = p.dep_hash RETURNING 1
  ), u2 AS (
    UPDATE public.ledger_inflow l SET seat_completion_of = p.dep_hash
      FROM pair p WHERE l.row_hash = p.bal_hash RETURNING 1
  )
  SELECT (SELECT count(*) FROM u1), (SELECT count(*) FROM u2) INTO v_dep, v_comp;

  -- A bare UPDATE with no WHERE is rejected outright by the API layer, which is
  -- how the nightly ledger import came to fail every night without a trace.
  -- Touching only the rows that actually change is both allowed and cheaper.
  UPDATE public.ledger_inflow l
     SET counts_as_sale = CASE
           WHEN l.is_seat_deposit THEN false
           WHEN l.seat_completion_of IS NOT NULL THEN true
           ELSE l.is_new_sale END,
         revenue_recognized = CASE
           WHEN l.is_seat_deposit THEN l.seat_completed_at IS NOT NULL
           WHEN l.seat_completion_of IS NOT NULL THEN true
           ELSE l.is_new_sale END
   WHERE l.counts_as_sale IS DISTINCT FROM (CASE
           WHEN l.is_seat_deposit THEN false
           WHEN l.seat_completion_of IS NOT NULL THEN true
           ELSE l.is_new_sale END)
      OR l.revenue_recognized IS DISTINCT FROM (CASE
           WHEN l.is_seat_deposit THEN l.seat_completed_at IS NOT NULL
           WHEN l.seat_completion_of IS NOT NULL THEN true
           ELSE l.is_new_sale END);

  return jsonb_build_object('deposits_completed', v_dep, 'completion_rows', v_comp,
    'deposits_total', (select count(*) from public.ledger_inflow where is_seat_deposit),
    'sales_total', (select count(*) from public.ledger_inflow where counts_as_sale));
end $function$;

-- Baselines, one grain at a time. All three grains in one statement exceeded
-- the database's time limit, so the nightly rebuild never once completed.
CREATE OR REPLACE FUNCTION public.rebuild_metric_baselines_grain(p_grain text, p_asof date DEFAULT NULL::date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_end date := COALESCE(p_asof, current_date - 1);
  v_count integer := 0;
BEGIN
  IF p_grain = 'day' THEN
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

  ELSIF p_grain = 'week' THEN
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
    ), up AS (
      INSERT INTO public.metric_baselines (metric_id, grain, weekday_class, median, mad, n_observations, computed_at)
      SELECT med.metric_id, 'week', 'all', med.median, dev.mad, med.n, now()
      FROM med JOIN dev ON dev.metric_id = med.metric_id
      ON CONFLICT (metric_id, grain, weekday_class) DO UPDATE SET
        median = excluded.median, mad = excluded.mad,
        n_observations = excluded.n_observations, computed_at = now()
      RETURNING 1
    ) SELECT count(*) INTO v_count FROM up;

  ELSIF p_grain = 'month' THEN
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
    ), up AS (
      INSERT INTO public.metric_baselines (metric_id, grain, weekday_class, median, mad, n_observations, computed_at)
      SELECT med.metric_id, 'month', 'all', med.median, dev.mad, med.n, now()
      FROM med JOIN dev ON dev.metric_id = med.metric_id
      ON CONFLICT (metric_id, grain, weekday_class) DO UPDATE SET
        median = excluded.median, mad = excluded.mad,
        n_observations = excluded.n_observations, computed_at = now()
      RETURNING 1
    ) SELECT count(*) INTO v_count FROM up;
  ELSE
    RAISE EXCEPTION 'unknown grain %', p_grain;
  END IF;

  RETURN v_count;
END $function$;

REVOKE ALL ON FUNCTION public.rebuild_metric_baselines_grain(text, date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_metric_baselines_grain(text, date) TO service_role;