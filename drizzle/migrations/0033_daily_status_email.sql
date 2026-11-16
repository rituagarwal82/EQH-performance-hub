CREATE TABLE public.daily_email_log (
  business_date date PRIMARY KEY,
  status text NOT NULL DEFAULT 'pending',
  subject text,
  body_text text,
  recipients text[],
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.daily_email_log TO authenticated;
GRANT ALL ON public.daily_email_log TO service_role;
ALTER TABLE public.daily_email_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "daily email log readable" ON public.daily_email_log FOR SELECT TO authenticated USING (true);
CREATE POLICY "daily email log service" ON public.daily_email_log FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Yesterday's figures, and the day before for the comparison, in one read.
-- Every part reports separately whether it actually has data for that day, so
-- the email can say "not available" instead of printing a zero.
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
           coalesce(sum(amount_received), 0)::numeric AS cash
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

INSERT INTO public.cron_manifest (jobname, schedule, url_path, body, plain_label, consequence, max_gap_hours, note, active)
VALUES
  ('daily-status-email', '0 7 * * *', '/api/public/cron/daily-email', '{}'::jsonb,
   'Daily status email to the owner', 'the owner stops receiving the daily summary and has to open the app to know anything', 24,
   'Sends the 12:30 IST owner summary. Idempotent: one email per business day.', true),
  ('daily-status-email-retry', '30 7 * * *', '/api/public/cron/daily-email', '{"retry":true}'::jsonb,
   'Daily status email — second attempt', 'a failed morning email is never resent', 24,
   'Runs 30 minutes after the first attempt and only sends if the day''s email has not gone out.', true)
ON CONFLICT (jobname) DO UPDATE
  SET schedule = EXCLUDED.schedule,
      url_path = EXCLUDED.url_path,
      body = EXCLUDED.body,
      plain_label = EXCLUDED.plain_label,
      consequence = EXCLUDED.consequence,
      max_gap_hours = EXCLUDED.max_gap_hours,
      note = EXCLUDED.note,
      active = true;

SELECT cron.schedule('daily-status-email', '0 7 * * *', $$select public.cron_post('daily-status-email')$$);
SELECT cron.schedule('daily-status-email-retry', '30 7 * * *', $$select public.cron_post('daily-status-email-retry')$$);