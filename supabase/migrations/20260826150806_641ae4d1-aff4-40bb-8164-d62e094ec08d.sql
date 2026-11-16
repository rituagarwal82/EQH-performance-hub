-- Anonymous visitors have no business calling any routine.
REVOKE EXECUTE ON FUNCTION
  public.rebuild_tm_sales(),
  public.tm_sales_coverage(date, date),
  public.zoom_session_rows(date, date, boolean),
  public.zoom_event_rows(date, date, boolean),
  public.zoom_retention_curve(text),
  public.tm_sales_daily(date, date),
  public.account_month_rollup(date, date),
  public.monthly_spend(integer),
  public.upsert_ad_entities(jsonb),
  public.upsert_daily_metrics(jsonb),
  public.upsert_tm_payments(jsonb),
  public.upsert_zoom_participants(jsonb),
  public.upsert_zoom_sessions(jsonb),
  public.business_date(timestamptz)
FROM anon, public;

-- Writers: service role only.
REVOKE EXECUTE ON FUNCTION
  public.rebuild_tm_sales(),
  public.upsert_ad_entities(jsonb),
  public.upsert_daily_metrics(jsonb),
  public.upsert_tm_payments(jsonb),
  public.upsert_zoom_participants(jsonb),
  public.upsert_zoom_sessions(jsonb)
FROM authenticated;

GRANT EXECUTE ON FUNCTION
  public.rebuild_tm_sales(),
  public.upsert_ad_entities(jsonb),
  public.upsert_daily_metrics(jsonb),
  public.upsert_tm_payments(jsonb),
  public.upsert_zoom_participants(jsonb),
  public.upsert_zoom_sessions(jsonb)
TO service_role;

-- Readers: signed-in dashboard users.
GRANT EXECUTE ON FUNCTION
  public.tm_sales_coverage(date, date),
  public.zoom_session_rows(date, date, boolean),
  public.zoom_event_rows(date, date, boolean),
  public.zoom_retention_curve(text),
  public.tm_sales_daily(date, date),
  public.account_month_rollup(date, date),
  public.monthly_spend(integer),
  public.business_date(timestamptz)
TO authenticated, service_role;