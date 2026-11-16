CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.schedule(
  'sync-meta-daily',
  '30 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c.lovable.app/api/public/cron/sync-meta',
    headers := '{"Content-Type": "application/json", "apikey": "sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);