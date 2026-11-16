CREATE OR REPLACE FUNCTION public.sabhi_chain(p_start date, p_end date)
 RETURNS TABLE(bucket text, spend numeric, clicks bigint, page_views bigint, registrations bigint, attended bigint, at_price bigint, buyers bigint, cash numeric, last_spend date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- "Still there when the price came" = still in the room 123+ minutes after
  -- the room opened (price at minute 107 of the recording; room opens ~16 min
  -- before recording). Last leave minus room open — never minutes watched.
  WITH b(bucket) AS (VALUES ('1249430309131428'),('1109475161619539'),('1488704194840585'),('google'),('meta_unidentified')),
  sp AS (
    SELECT sabhi_bucket_of_account(account_id) bucket, sum(spend) spend, sum(link_clicks)::bigint clicks,
           sum(landing_page_views)::bigint lpv
    FROM daily_metrics WHERE level='ad' AND date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  ls AS (
    SELECT sabhi_bucket_of_account(account_id) bucket, max(date) d FROM daily_metrics
    WHERE level='ad' AND spend > 0 AND date <= p_end GROUP BY 1
  ),
  r AS (SELECT * FROM sabhi_first_regs(p_start, p_end)),
  att AS (
    SELECT r.bucket, r.email_key, max(z.last_leave - s.start_time) stay
    FROM r JOIN zoom_attendance z ON z.email = r.email_key
    JOIN zoom_sessions s ON s.session_uuid = z.session_uuid AND s.session_role = 'live'
      AND s.business_date BETWEEN r.reg_date AND r.reg_date + 7
    GROUP BY 1,2
  ),
  sa AS (SELECT * FROM sabhi_sales(p_start, p_end))
  SELECT b.bucket,
    sp.spend, sp.clicks, sp.lpv,
    (SELECT count(DISTINCT email_key) FROM r WHERE r.bucket=b.bucket),
    (SELECT count(*) FROM att WHERE att.bucket=b.bucket),
    (SELECT count(*) FROM att WHERE att.bucket=b.bucket AND stay >= interval '123 minutes'),
    (SELECT count(*) FROM sa WHERE sa.bucket=b.bucket),
    (SELECT sum(sa.cash) FROM sa WHERE sa.bucket=b.bucket),
    CASE WHEN b.bucket='google' THEN DATE '2026-08-26' ELSE ls.d END
  FROM b LEFT JOIN sp ON sp.bucket=b.bucket LEFT JOIN ls ON ls.bucket=b.bucket;
$function$;