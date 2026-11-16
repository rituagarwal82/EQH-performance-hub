-- Twelve months of series in one statement always exceeded the time limit.
-- One month per call finishes comfortably; the caller paces the twelve.
CREATE OR REPLACE FUNCTION public.metric_month_values(p_month_start date)
 RETURNS TABLE(metric_id text, value numeric)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT m.metric_id, m.value
  FROM public.metric_series(p_month_start,
                            (p_month_start + interval '1 month - 1 day')::date,
                            'month') m
  WHERE m.value IS NOT NULL AND m.complete
$function$;

CREATE OR REPLACE FUNCTION public.write_metric_baselines(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  WITH up AS (
    INSERT INTO public.metric_baselines (metric_id, grain, weekday_class, median, mad, n_observations, computed_at)
    SELECT r->>'metric_id', r->>'grain', coalesce(r->>'weekday_class','all'),
           (r->>'median')::numeric, (r->>'mad')::numeric,
           coalesce((r->>'n')::int, 0), now()
    FROM jsonb_array_elements(p_rows) r
    ON CONFLICT (metric_id, grain, weekday_class) DO UPDATE SET
      median = excluded.median, mad = excluded.mad,
      n_observations = excluded.n_observations, computed_at = now()
    RETURNING 1
  ) SELECT count(*) INTO v_count FROM up;
  RETURN v_count;
END $function$;

REVOKE ALL ON FUNCTION public.metric_month_values(date) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.write_metric_baselines(jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.metric_month_values(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.write_metric_baselines(jsonb) TO service_role;