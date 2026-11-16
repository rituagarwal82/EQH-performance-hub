-- ============ SEC2: job caller reads its key from settings ============
INSERT INTO public.app_settings (key, value, description) VALUES
  ('cron_api_key', 'sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS',
   'Publishable key the scheduled jobs send as apikey. Rotate here, not in cron_post.'),
  ('cron_base_url_note', 'Preview host in use because the dashboard is not published yet. Point cron_base_url at the published host on first publish.',
   'Why cron_base_url is what it is')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now();

CREATE OR REPLACE FUNCTION public.cron_post(p_jobname text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m record; v_base text; v_key text; v_url text; v_id bigint;
begin
  select * into m from public.cron_manifest where jobname = p_jobname;
  if not found then raise exception 'no manifest row for %', p_jobname; end if;
  select value into v_base from public.app_settings where key = 'cron_base_url';
  select value into v_key  from public.app_settings where key = 'cron_api_key';
  if v_base is null or v_key is null then
    raise exception 'cron_base_url or cron_api_key missing from app_settings';
  end if;
  v_url := v_base || m.url_path;
  select net.http_post(
    url := v_url,
    body := m.body,
    headers := jsonb_build_object('Content-Type','application/json','apikey', v_key),
    timeout_milliseconds := m.timeout_ms) into v_id;
  insert into public.cron_http_calls (request_id, jobname, url)
  values (v_id, p_jobname, v_url)
  on conflict (request_id) do nothing;
  return v_id;
end
$function$;

-- ============ CR: every route under cron/ is visible to the monitor ============
INSERT INTO public.cron_manifest (jobname, schedule, url_path, body, max_gap_hours, active, note, timeout_ms) VALUES
  ('discover-accounts-weekly', '15 2 * * 1', '/api/public/cron/discover-accounts', '{}'::jsonb, 200, true,
   'Enumerates every visible ad account and registers new ones.', 120000),
  ('zoom-host-backfill', 'on demand', '/api/public/cron/zoom-host-backfill', '{}'::jsonb, 0, false,
   'On demand: resumable backfill of missing Zoom host ids.', 120000),
  ('seed-scripts', 'on demand', '/api/public/seed-scripts', '{}'::jsonb, 0, false,
   'On demand: seeds the creative script registry.', 60000)
ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, url_path = EXCLUDED.url_path,
  active = EXCLUDED.active, note = EXCLUDED.note, updated_at = now();

SELECT cron.schedule('discover-accounts-weekly', '15 2 * * 1', $$select public.cron_post('discover-accounts-weekly')$$);

-- ============ TR: transcript store cannot express two sessions ============
UPDATE public.webinar_transcripts SET session_ref = 'X8yXwkdeSP+QIFIW1D9xwg==', segment_no = 0
 WHERE id = '4696f234-1be4-4e08-8501-714bb6c60630';
UPDATE public.webinar_transcripts SET session_ref = 'pr8dEDT1Ti6dfrvhwQGQaQ==', segment_no = 0
 WHERE id = '36b82e6d-ccb7-4497-8d26-1b9ef85c3176';

ALTER TABLE public.webinar_transcripts
  DROP CONSTRAINT IF EXISTS webinar_transcripts_session_match_hint_segment_no_source_key;
DROP INDEX IF EXISTS public.webinar_transcripts_session_match_hint_segment_no_source_key;

ALTER TABLE public.webinar_transcripts
  ADD CONSTRAINT webinar_transcripts_session_fk
  FOREIGN KEY (session_ref) REFERENCES public.zoom_sessions(session_uuid) ON DELETE SET NULL;

-- segment_no orders segments WITHIN one session, so the key is session-scoped.
CREATE UNIQUE INDEX webinar_transcripts_session_segment_uq
  ON public.webinar_transcripts (coalesce(session_ref, session_match_hint), segment_no, source);

-- Exactly one canonical transcript per session.
CREATE UNIQUE INDEX webinar_transcripts_one_canonical_uq
  ON public.webinar_transcripts (coalesce(session_ref, session_match_hint))
  WHERE is_canonical;

UPDATE public.webinar_transcripts SET coverage = 'unknown' WHERE coverage IS NULL;
ALTER TABLE public.webinar_transcripts
  ALTER COLUMN coverage SET DEFAULT 'unknown',
  ALTER COLUMN coverage SET NOT NULL,
  ADD CONSTRAINT webinar_transcripts_coverage_chk
  CHECK (coverage IN ('full','intro_segment','offer_segment','partial','unknown'));

COMMENT ON COLUMN public.webinar_transcripts.segment_no IS
  'Order of this segment WITHIN one session (session_ref). Never an identifier for the session itself.';

-- ============ dead SQL: ambiguous overload ============
DROP FUNCTION IF EXISTS public.ledger_reconciliation(integer, text);