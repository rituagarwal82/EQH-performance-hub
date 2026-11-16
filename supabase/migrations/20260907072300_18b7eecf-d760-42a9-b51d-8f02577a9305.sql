-- Applied by hand on 2026-09-07 during the timeout incident; recorded here so a rebuild cannot lose it.
CREATE INDEX IF NOT EXISTS leads_email_captured_idx
  ON public.leads (email_key, captured_at)
  WHERE email_key IS NOT NULL AND email_key <> '';

-- lead_page_rollup scanned 664MB of heap for a 7-day window (4.5s measured).
-- Covering index makes it an index-only scan.
CREATE INDEX IF NOT EXISTS leads_business_date_page_idx
  ON public.leads (business_date)
  INCLUDE (landing_page, utm_campaign, is_registered);

ANALYZE public.leads;
ANALYZE public.ledger_inflow;
ANALYZE public.zoom_participants;
ANALYZE public.zoom_sessions;
ANALYZE public.daily_metrics;