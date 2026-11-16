CREATE OR REPLACE FUNCTION public.daily_sale_sources(p_date date)
RETURNS TABLE(email_key text, payer_name text, rows_count int, cash numeric, channel text, source text,
              paid_direct boolean, first_reg date, has_lead boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH s AS (
    SELECT li.email_key, li.payer_name, li.receipt_source, li.amount_received, sa.channel, sa.source
    FROM ledger_inflow li LEFT JOIN sale_attribution sa ON sa.row_hash = li.row_hash
    WHERE li.business_date = p_date AND li.product_tier = 'L1_SILVER'
      AND li.is_new_sale AND li.counts_as_sale
  ), b AS (
    SELECT coalesce(nullif(s.email_key,''), 'name:' || lower(s.payer_name)) AS k,
           min(s.payer_name) AS payer_name, count(*)::int AS rows_count,
           sum(s.amount_received) AS cash, min(s.channel) AS channel, min(s.source) AS source,
           bool_and(s.receipt_source NOT ILIKE 'TagMango%') AS paid_direct
    FROM s GROUP BY 1
  )
  SELECT b.k, b.payer_name, b.rows_count, b.cash, b.channel, b.source, b.paid_direct,
         (SELECT min(l.business_date) FROM leads l WHERE l.email_key = b.k),
         EXISTS (SELECT 1 FROM leads l WHERE l.email_key = b.k)
  FROM b;
$$;
GRANT EXECUTE ON FUNCTION public.daily_sale_sources(date) TO authenticated, service_role;

INSERT INTO public.cron_manifest (jobname, schedule, url_path, body, plain_label, consequence, max_gap_hours, note, active)
VALUES ('sync-ledger-evening', '30 11 * * *', '/api/public/sync-ledger', '{"refresh":true}'::jsonb,
  'Collections ledger import — 5 p.m. read', 'the 6 p.m. email counts yesterday''s sales from a sheet the accounts team had not finished posting', 24,
  'Second daily read of the accounts sheet (trailing 60 days) so the 6 p.m. email sees the midday posting.', true)
ON CONFLICT (jobname) DO UPDATE SET schedule=EXCLUDED.schedule, url_path=EXCLUDED.url_path, body=EXCLUDED.body,
  plain_label=EXCLUDED.plain_label, consequence=EXCLUDED.consequence, note=EXCLUDED.note, active=true;

UPDATE public.cron_manifest SET schedule='30 12 * * *', note='Sends the 18:00 IST owner summary. Idempotent: one email per business day.' WHERE jobname='daily-status-email';
UPDATE public.cron_manifest SET schedule='0 13 * * *' WHERE jobname='daily-status-email-retry';

SELECT cron.schedule('sync-ledger-evening', '30 11 * * *', $$select public.cron_post('sync-ledger-evening')$$);
SELECT cron.schedule('daily-status-email', '30 12 * * *', $$select public.cron_post('daily-status-email')$$);
SELECT cron.schedule('daily-status-email-retry', '0 13 * * *', $$select public.cron_post('daily-status-email-retry')$$);