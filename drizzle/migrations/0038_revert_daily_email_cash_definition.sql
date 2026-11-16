-- Put the daily email's cash figure back exactly as it was before today's
-- (now held) content changes: every rupee received that day against the first
-- course. The definition decision is the owner's to make, not ours.
CREATE OR REPLACE FUNCTION public.daily_email_figures(p_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v jsonb;
BEGIN
  WITH days AS (
    SELECT p_date AS d, 'day'::text AS slot
    UNION ALL SELECT p_date - 1, 'prev'
  ), sp AS (
    SELECT date, spend, leads FROM public.daily_spend_series(p_date - 1, p_date)
  ), has_spend AS (
    SELECT date::date AS d, true AS present
      FROM public.daily_metrics
     WHERE date BETWEEN p_date - 1 AND p_date
     GROUP BY 1
  ), zoom AS (
    SELECT business_date AS d,
           sum(total_registrants)::numeric AS reg,
           sum(attendees)::numeric AS att,
           count(*)::int AS sessions
      FROM public.zoom_session_rows(p_date - 1, p_date)
     GROUP BY 1
  ), led AS (
    SELECT business_date AS d,
           count(*) FILTER (WHERE is_new_sale)::int AS sales,
           count(*) FILTER (WHERE counts_as_sale)::int AS fully_paid,
           coalesce(sum(amount_received), 0)::numeric AS cash,
           coalesce(sum(amount_received) FILTER (WHERE is_new_sale), 0)::numeric AS cash_new_sales
      FROM public.ledger_inflow
     WHERE product_tier = 'L1_SILVER'
       AND business_date BETWEEN p_date - 1 AND p_date
     GROUP BY 1
  ), ledger_seen AS (
    SELECT max(business_date) AS edge FROM public.ledger_inflow
  )
  SELECT jsonb_object_agg(
           days.slot,
           jsonb_build_object(
             'date', days.d,
             'spend', sp.spend,
             'spend_available', coalesce(has_spend.present, false),
             'registrations', sp.leads,
             'sessions', coalesce(zoom.sessions, 0),
             'attendees', zoom.att,
             'zoom_registrants', zoom.reg,
             'show_up_pct', CASE WHEN coalesce(zoom.reg, 0) > 0
                                 THEN round(100 * zoom.att / zoom.reg, 1) END,
             'sales', coalesce(led.sales, 0),
             'fully_paid', coalesce(led.fully_paid, 0),
             'cash', coalesce(led.cash, 0),
             'cash_new_sales', coalesce(led.cash_new_sales, 0),
             'ledger_covers_day', (SELECT edge >= days.d FROM ledger_seen)
           )
         )
    INTO v
    FROM days
    LEFT JOIN sp ON sp.date = days.d
    LEFT JOIN has_spend ON has_spend.d = days.d
    LEFT JOIN zoom ON zoom.d = days.d
    LEFT JOIN led ON led.d = days.d;

  RETURN coalesce(v, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.daily_email_figures(date) TO service_role, authenticated;