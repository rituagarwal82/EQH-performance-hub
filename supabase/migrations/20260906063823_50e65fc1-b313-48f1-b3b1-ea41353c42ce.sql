CREATE OR REPLACE FUNCTION public.ledger_range_totals(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER')
 RETURNS TABLE(sales bigint, collected numeric, pending numeric, rows_count bigint, buyers bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT coalesce(sum(CASE WHEN l.is_new_sale THEN 1 ELSE 0 END),0)::bigint,
         coalesce(sum(l.amount_received),0)::numeric,
         coalesce(sum(l.amount_pending),0)::numeric,
         count(*)::bigint,
         count(DISTINCT l.email_key)::bigint
    FROM public.ledger_inflow l
   WHERE l.business_date BETWEEN p_start AND p_end
     AND (p_tier IS NULL OR l.product_tier = p_tier)
$function$;
REVOKE EXECUTE ON FUNCTION public.ledger_range_totals(date,date,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.ledger_range_totals(date,date,text) TO authenticated, service_role;

SELECT cron.schedule('run-goldens-nightly', '20 6 * * *', $job$
  select net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app/api/public/cron/run-goldens',
    body := '{}'::jsonb,
    headers := '{"Content-Type":"application/json","apikey":"sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    timeout_milliseconds := 600000);
$job$);

INSERT INTO public.cron_manifest (jobname, schedule, url_path, body, max_gap_hours, active, note)
VALUES ('run-goldens-nightly','20 6 * * *','/api/public/cron/run-goldens','{}'::jsonb, 30, true,
        'Re-checks every verified historical figure and every metric definition fingerprint')
ON CONFLICT (jobname) DO UPDATE SET schedule = excluded.schedule, url_path = excluded.url_path,
  body = excluded.body, max_gap_hours = excluded.max_gap_hours, active = true, note = excluded.note;