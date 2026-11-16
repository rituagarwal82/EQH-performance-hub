-- Stale planner statistics after the 240k-row CRM import were what made the
-- dashboard time out. Any job that writes rows now refreshes them itself.
CREATE OR REPLACE FUNCTION public.analyze_tables(p_tables text[])
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t text;
  done text[] := '{}';
begin
  foreach t in array coalesce(p_tables, '{}') loop
    if exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = t and c.relkind = 'r'
    ) then
      execute format('analyze public.%I', t);
      done := done || t;
    end if;
  end loop;
  return done;
end;
$function$;

REVOKE ALL ON FUNCTION public.analyze_tables(text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analyze_tables(text[]) TO service_role;

-- Heavy upserts: refresh stats after 2% churn, not 10%.
ALTER TABLE public.leads SET (autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_scale_factor = 0.05);
ALTER TABLE public.ledger_inflow SET (autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.zoom_participants SET (autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.daily_metrics SET (autovacuum_analyze_scale_factor = 0.02);

-- Weekly backstop, Sunday 19:30 UTC (Monday 01:00 IST, outside webinar hours).
SELECT cron.unschedule('analyze-core-tables-weekly')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'analyze-core-tables-weekly');

SELECT cron.schedule(
  'analyze-core-tables-weekly',
  '30 19 * * 0',
  $$select public.analyze_tables(array[
      'leads','ledger_inflow','zoom_participants','zoom_sessions',
      'daily_metrics','demo_metrics','tm_enrolments','tm_payments','tm_sales',
      'ad_entities','ad_accounts','recording_transcript_cues','webinar_transcript_lines'
    ])$$
);