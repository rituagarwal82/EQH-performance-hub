CREATE OR REPLACE VIEW public.sync_health AS
WITH last_ok AS (
  SELECT source, max(COALESCE(finished_at, started_at)) AS at
  FROM public.sync_runs
  WHERE status IN ('success','ok','partial')
  GROUP BY source
), last_any AS (
  SELECT source, max(started_at) AS at FROM public.sync_runs GROUP BY source
), fails AS (
  SELECT r.source, count(*) AS n
  FROM public.sync_runs r
  LEFT JOIN last_ok o_1 ON o_1.source = r.source
  WHERE r.status IN ('error','warning')
    AND (o_1.at IS NULL OR r.started_at > o_1.at)
  GROUP BY r.source
)
SELECT c.source, c.label, c.cadence_hours, c.is_critical, c.note,
  o.at AS last_success, a.at AS last_run,
  CASE WHEN o.at IS NULL THEN NULL::numeric
       ELSE round(EXTRACT(epoch FROM now() - o.at) / 3600.0, 1) END AS hours_since_success,
  COALESCE(f.n, 0)::integer AS consecutive_failures,
  (SELECT r.error FROM public.sync_runs r
    WHERE r.source = c.source AND r.error IS NOT NULL
    ORDER BY r.started_at DESC LIMIT 1) AS last_error,
  CASE
    WHEN o.at IS NULL THEN 'dead'
    WHEN (EXTRACT(epoch FROM now() - o.at) / 3600.0) >= (c.cadence_hours * 3::numeric) THEN 'dead'
    WHEN (EXTRACT(epoch FROM now() - o.at) / 3600.0) >= (c.cadence_hours * 1.5) THEN 'late'
    ELSE 'ok'
  END AS status
FROM public.sync_source_config c
LEFT JOIN last_ok o ON o.source = c.source
LEFT JOIN last_any a ON a.source = c.source
LEFT JOIN fails f ON f.source = c.source;