-- D1: measured registrations in the daily series
DROP FUNCTION IF EXISTS public.daily_spend_series(date, date);
CREATE FUNCTION public.daily_spend_series(p_start date, p_end date)
 RETURNS TABLE(date date, spend numeric, leads bigint, measured_spend numeric, measured_leads bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    m.date,
    SUM(m.spend)::numeric,
    SUM(m.leads)::bigint,
    SUM(m.spend) FILTER (WHERE a.lead_tracking_status = 'working')::numeric,
    SUM(m.leads) FILTER (WHERE a.lead_tracking_status = 'working')::bigint
  FROM public.daily_metrics m
  JOIN public.ad_accounts a ON a.account_id = m.account_id
  WHERE m.level = 'account' AND m.date >= p_start AND m.date <= p_end
  GROUP BY m.date
  ORDER BY m.date
$function$;
REVOKE EXECUTE ON FUNCTION public.daily_spend_series(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.daily_spend_series(date, date) TO authenticated, service_role;

-- D10: materialise the attribution snapshot
CREATE MATERIALIZED VIEW IF NOT EXISTS public.lead_attribution_mv AS
SELECT * FROM public.lead_attribution;

CREATE UNIQUE INDEX IF NOT EXISTS lead_attribution_mv_email_idx
  ON public.lead_attribution_mv (email_key);
CREATE INDEX IF NOT EXISTS lead_attribution_mv_paid_idx
  ON public.lead_attribution_mv (is_paid);

GRANT SELECT ON public.lead_attribution_mv TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.refresh_lead_attribution()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE n bigint;
BEGIN
  BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.lead_attribution_mv;
  EXCEPTION WHEN OTHERS THEN
    REFRESH MATERIALIZED VIEW public.lead_attribution_mv;
  END;
  ANALYZE public.lead_attribution_mv;
  SELECT count(*) INTO n FROM public.lead_attribution_mv;
  RETURN 'lead_attribution_mv refreshed: ' || n || ' buyers';
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.refresh_lead_attribution() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_lead_attribution() TO authenticated, service_role;

-- D10 + D11: scope the join to the window's buyers, and count only recognised revenue
CREATE OR REPLACE FUNCTION public.ledger_attribution_buckets(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER'::text)
 RETURNS TABLE(bucket text, buyers bigint, sales bigint, collected numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH b AS (
    SELECT i.email_key,
           SUM(CASE WHEN i.counts_as_sale THEN 1 ELSE 0 END)::bigint AS sales,
           SUM(i.amount_received) FILTER (WHERE i.revenue_recognized)::numeric AS collected
    FROM public.ledger_inflow i
    WHERE i.product_tier = p_tier AND i.business_date BETWEEN p_start AND p_end
    GROUP BY i.email_key
  ),
  link AS (
    SELECT b.email_key,
           (SELECT k.lead_email_key
              FROM public.buyer_lead_link k
             WHERE k.email_key = b.email_key
             LIMIT 1) AS lead_email_key
    FROM b
  )
  SELECT
    CASE WHEN a.email_key IS NULL THEN 'NO_LEAD_RECORD'
         WHEN a.is_paid THEN 'PAID'
         ELSE 'LEAD_NOT_PAID' END,
    COUNT(*)::bigint,
    COALESCE(SUM(b.sales), 0)::bigint,
    COALESCE(SUM(b.collected), 0)::numeric
  FROM b
  LEFT JOIN link ON link.email_key = b.email_key
  LEFT JOIN public.lead_attribution_mv a ON a.email_key = link.lead_email_key
  GROUP BY 1
$function$;

-- D4: sales and paid sales come from the ledger, TagMango stays a witness
CREATE OR REPLACE FUNCTION public.metric_components(p_start date, p_end date)
 RETURNS TABLE(date date, spend numeric, measured_spend numeric, registrations bigint, registrants bigint, attendees bigint, attendees_matched bigint, sessions_without_registrants bigint, at_60 bigint, sales bigint, paid_sales bigint, collected numeric, has_meta boolean, has_zoom boolean, has_ledger boolean, tm_sales bigint, ledger_sales bigint, has_tm boolean, ledger_settling boolean)
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
  led AS (
    SELECT l.business_date AS date,
           count(*) FILTER (WHERE l.counts_as_sale)::bigint AS sales,
           count(*) FILTER (
             WHERE l.counts_as_sale AND EXISTS (
               SELECT 1
                 FROM public.buyer_lead_link k
                 JOIN public.lead_attribution_mv la ON la.email_key = k.lead_email_key
                WHERE k.email_key = l.email_key
                  AND la.is_paid
                  AND public.agency_spend_synced(la.agency_code)
             )
           )::bigint AS paid_sales,
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
         led.sales, led.paid_sales,
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
  ORDER BY d.date
$function$;

-- D5: the proof harness must examine the same spend the screens show
CREATE OR REPLACE FUNCTION public.proof_inputs(p_start date, p_end date)
 RETURNS TABLE(date date, meta_spend numeric, tm_sales bigint, ledger_sales bigint, settled boolean, leads_registered bigint, zoom_registrants bigint, zoom_valid_participants bigint, zoom_total_attendees bigint, zoom_sessions_n bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH d AS (
    SELECT g::date AS date
    FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
  ),
  mc AS (SELECT * FROM public.metric_components(p_start, p_end)),
  meta AS (
    SELECT m.date, sum(m.spend)::numeric AS spend
      FROM public.daily_metrics m
      JOIN public.ad_accounts a ON a.account_id = m.account_id
     WHERE m.level = 'account' AND m.date BETWEEN p_start AND p_end
     GROUP BY m.date
  ),
  lead AS (
    SELECT l.business_date AS date, count(*) FILTER (WHERE l.is_registered)::bigint AS n
      FROM public.leads l
     WHERE l.business_date BETWEEN p_start AND p_end
     GROUP BY l.business_date
  ),
  zs AS (
    SELECT z.business_date AS date,
           sum(z.total_registrants)::bigint AS registrants,
           sum(z.total_attendees)::bigint AS attendees,
           count(*)::bigint AS sessions_n
      FROM public.zoom_sessions z
     WHERE z.business_date BETWEEN p_start AND p_end
       AND z.total_attendees IS NOT NULL
     GROUP BY z.business_date
  ),
  zp AS (
    SELECT s.business_date AS date, sum(s.n)::bigint AS n
      FROM (
        SELECT z.business_date,
               count(DISTINCT coalesce(nullif(lower(p.email), ''), p.participant_id, p.name))::bigint AS n
          FROM public.zoom_participants p
          JOIN public.zoom_sessions z ON z.session_uuid = p.session_uuid
         WHERE p.is_valid
           AND z.business_date BETWEEN p_start AND p_end
           AND z.total_attendees IS NOT NULL
         GROUP BY z.business_date, z.session_uuid
      ) s
     GROUP BY s.business_date
  )
  SELECT d.date,
         meta.spend,
         mc.tm_sales,
         mc.ledger_sales,
         NOT coalesce(mc.ledger_settling, true) AS settled,
         lead.n,
         zs.registrants,
         zp.n,
         zs.attendees,
         coalesce(zs.sessions_n, 0)
    FROM d
    LEFT JOIN mc   ON mc.date   = d.date
    LEFT JOIN meta ON meta.date = d.date
    LEFT JOIN lead ON lead.date = d.date
    LEFT JOIN zs   ON zs.date   = d.date
    LEFT JOIN zp   ON zp.date   = d.date
   ORDER BY d.date
$function$;

-- D5: same universe for the morning analyst
CREATE OR REPLACE FUNCTION public.analyst_decomposition(p_date date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH d AS (
    SELECT m.date,
           SUM(m.spend) AS spend,
           SUM(m.impressions) AS impressions,
           SUM(m.link_clicks) AS link_clicks,
           SUM(m.leads) FILTER (WHERE m.leads IS NOT NULL) AS leads
    FROM public.daily_metrics m
    JOIN public.ad_accounts a ON a.account_id = m.account_id
    WHERE m.level = 'account'
      AND m.date BETWEEN p_date - 28 AND p_date
    GROUP BY m.date
  ), r AS (
    SELECT date,
           spend, impressions, link_clicks, leads,
           CASE WHEN link_clicks > 0 THEN spend / link_clicks END AS cpc,
           CASE WHEN link_clicks > 0 AND leads IS NOT NULL THEN leads::numeric / link_clicks END AS click_to_lead,
           CASE WHEN impressions > 0 THEN link_clicks::numeric / impressions END AS ctr
    FROM d
  )
  SELECT jsonb_build_object(
    'date', p_date,
    'today', (SELECT to_jsonb(r) FROM r WHERE r.date = p_date),
    'baseline_28d', (
      SELECT jsonb_build_object(
        'days', COUNT(*),
        'cpc_median', percentile_cont(0.5) WITHIN GROUP (ORDER BY cpc),
        'click_to_lead_median', percentile_cont(0.5) WITHIN GROUP (ORDER BY click_to_lead),
        'ctr_median', percentile_cont(0.5) WITHIN GROUP (ORDER BY ctr)
      ) FROM r WHERE r.date < p_date
    )
  );
$function$;

-- D15: sales cannot be split by team, so refuse it structurally
UPDATE public.metric_contracts
   SET note = coalesce(note, '') || ' | 2026-09-07: not splittable by team — the ledger has no team key',
       updated_at = now()
 WHERE metric_id = 'ledger_l1_new_sales';