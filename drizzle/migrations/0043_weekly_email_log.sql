CREATE TABLE public.weekly_email_log (
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

GRANT SELECT ON public.weekly_email_log TO authenticated;
GRANT ALL ON public.weekly_email_log TO service_role;

ALTER TABLE public.weekly_email_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "weekly_email_log readable by signed-in users"
  ON public.weekly_email_log FOR SELECT TO authenticated USING (true);

CREATE POLICY "weekly_email_log written by service role"
  ON public.weekly_email_log FOR ALL TO service_role USING (true) WITH CHECK (true);