CREATE TABLE public.agency_spend_status (
  agency_code text PRIMARY KEY,
  spend_synced boolean NOT NULL DEFAULT false,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.agency_spend_status TO authenticated;
GRANT ALL ON public.agency_spend_status TO service_role;

ALTER TABLE public.agency_spend_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency_spend_status readable by authenticated"
  ON public.agency_spend_status FOR SELECT TO authenticated USING (true);
CREATE POLICY "agency_spend_status service role writes"
  ON public.agency_spend_status FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER update_agency_spend_status_updated_at
BEFORE UPDATE ON public.agency_spend_status
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.agency_spend_status (agency_code, spend_synced, note) VALUES
  ('SD',  true,  'Sabhi Digital ad accounts are visible to the Meta token and sync daily.'),
  ('RJ',  false, 'RJ ad account not yet connected — spend unknown'),
  ('PRM', false, 'Parami has no ad account yet — spend unknown');

-- true when the team's spend is connected; unknown/absent codes are treated as connected
CREATE OR REPLACE FUNCTION public.agency_spend_synced(p_code text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (SELECT s.spend_synced FROM public.agency_spend_status s WHERE s.agency_code = p_code),
    true)
$$;

REVOKE ALL ON FUNCTION public.agency_spend_synced(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agency_spend_synced(text) TO service_role;

-- ledger_paid_daily: exclude paid cash whose team's spend is not connected
DROP FUNCTION IF EXISTS public.ledger_paid_daily(date, date);
CREATE OR REPLACE FUNCTION public.ledger_paid_daily(p_start date, p_end date)
RETURNS TABLE(business_date date, collected_all numeric, collected_new_sale numeric,
              collected_no_lead numeric, collected_instalment numeric,
              collected_paid_gross numeric, collected_paid_exgst numeric,
              rows_all bigint, rows_paid bigint,
              collected_unsynced_gross numeric, rows_unsynced bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH l AS (
    SELECT li.business_date, li.amount_received, li.is_new_sale,
           EXISTS (SELECT 1 FROM public.leads x WHERE x.email_key = li.email_key) AS has_lead,
           EXISTS (SELECT 1 FROM public.lead_attribution la
                    WHERE la.email_key = li.email_key AND la.is_paid) AS has_paid_marker,
           COALESCE(public.agency_spend_synced(
             (SELECT la.agency_code FROM public.lead_attribution la
               WHERE la.email_key = li.email_key AND la.is_paid LIMIT 1)), true) AS spend_synced
      FROM public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND li.email_key IS NOT NULL
    UNION ALL
    SELECT li.business_date, li.amount_received, li.is_new_sale, false, false, true
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
         coalesce(sum(l.amount_received) FILTER (WHERE l.is_new_sale AND l.has_paid_marker AND l.spend_synced), 0)::numeric,
         round(coalesce(sum(l.amount_received) FILTER (WHERE l.is_new_sale AND l.has_paid_marker AND l.spend_synced), 0)::numeric / 1.18, 2),
         count(*)::bigint,
         count(*) FILTER (WHERE l.is_new_sale AND l.has_paid_marker AND l.spend_synced)::bigint,
         coalesce(sum(l.amount_received) FILTER (WHERE l.is_new_sale AND l.has_paid_marker AND NOT l.spend_synced), 0)::numeric,
         count(*) FILTER (WHERE l.is_new_sale AND l.has_paid_marker AND NOT l.spend_synced)::bigint
    FROM l GROUP BY l.business_date ORDER BY l.business_date
$$;

REVOKE ALL ON FUNCTION public.ledger_paid_daily(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_paid_daily(date, date) TO service_role;

-- paid_sales counts only leads whose team's spend is connected
CREATE OR REPLACE FUNCTION public.metric_components(p_start date, p_end date)
RETURNS TABLE(date date, spend numeric, measured_spend numeric, registrations bigint, registrants bigint, attendees bigint, attendees_matched bigint, sessions_without_registrants bigint, at_60 bigint, sales bigint, paid_sales bigint, collected numeric, has_meta boolean, has_zoom boolean, has_ledger boolean, tm_sales bigint, ledger_sales bigint, has_tm boolean, ledger_settling boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
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
           count(DISTINCT e.person_key) FILTER (
             WHERE EXISTS (SELECT 1 FROM public.lead_attribution la
                            WHERE la.email_key = e.person_key AND la.is_paid
                              AND public.agency_spend_synced(la.agency_code))
           )::bigint AS paid_sales,
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
         zoom.registrants, zoom.attendees, zoom.attendees_matched,
         COALESCE(zoom.sessions_without_registrants, 0),
         zoom.at_60,
         tm.sales, tm.paid_sales,
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
$$;

REVOKE ALL ON FUNCTION public.metric_components(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.metric_components(date, date) TO service_role;

-- excluded cash for a window, for the UI note and the invariant
CREATE OR REPLACE FUNCTION public.spend_symmetry(p_start date, p_end date)
RETURNS TABLE(excluded_cash numeric, excluded_rows bigint, teams text[])
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH pd AS (SELECT * FROM public.ledger_paid_daily(p_start, p_end)),
  t AS (
    SELECT DISTINCT la.agency_code
      FROM public.ledger_inflow li
      JOIN public.lead_attribution la ON la.email_key = li.email_key AND la.is_paid
     WHERE li.product_tier = 'L1_SILVER' AND li.is_new_sale
       AND li.business_date BETWEEN p_start AND p_end
       AND NOT public.agency_spend_synced(la.agency_code)
  )
  SELECT coalesce(sum(pd.collected_unsynced_gross), 0)::numeric,
         coalesce(sum(pd.rows_unsynced), 0)::bigint,
         coalesce((SELECT array_agg(coalesce(t.agency_code,'UNASSIGNED') ORDER BY t.agency_code) FROM t), '{}'::text[])
    FROM pd
$$;

REVOKE ALL ON FUNCTION public.spend_symmetry(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.spend_symmetry(date, date) TO service_role;

INSERT INTO public.proof_registry (check_id, family, label, plain, expected_noise, fp_budget_per_30d, ord, enabled)
VALUES ('inv_spend_symmetry', 'invariant', 'Revenue only counted where its cost is visible',
        'Paid-performance ratios may only use cash from teams whose ad spend actually reaches us. Cash from a team whose ad account is not connected is held out and shown separately.',
        'Never, while every selling team''s ad account is connected.',
        0, 19, true)
ON CONFLICT (check_id) DO UPDATE
  SET family = EXCLUDED.family, label = EXCLUDED.label, plain = EXCLUDED.plain,
      expected_noise = EXCLUDED.expected_noise, ord = EXCLUDED.ord, enabled = true;