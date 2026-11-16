-- O2: L1 webinars are simulive (pre-recorded video played as a live session).

ALTER TABLE public.zoom_sessions
  ADD COLUMN IF NOT EXISTS session_format text;

COMMENT ON COLUMN public.zoom_sessions.session_format IS
  'simulive = a pre-recorded video played as a live session, team live in chat. Retention differences between simulive sessions are audience differences, never delivery differences.';

UPDATE public.zoom_sessions
   SET session_format = 'simulive'
 WHERE session_role IN ('live','replay')
   AND session_format IS DISTINCT FROM 'simulive';

-- The canonical transcript for a date: one script applies to EVERY session in
-- its effective-from window, because the video is identical every time.
CREATE OR REPLACE FUNCTION public.canonical_transcript_at(_d date)
RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT t.id
    FROM public.webinar_transcripts t
   WHERE t.is_canonical
     AND t.coverage = 'full'
     AND t.effective_from <= _d
   ORDER BY t.effective_from DESC
   LIMIT 1
$$;

-- Script coverage is per script version, not per session.
CREATE OR REPLACE VIEW public.session_script_coverage
WITH (security_invoker = true) AS
  SELECT s.session_uuid,
         s.business_date,
         s.session_role,
         s.session_format,
         public.canonical_transcript_at(s.business_date) AS transcript_id,
         (public.canonical_transcript_at(s.business_date) IS NOT NULL) AS has_script
    FROM public.zoom_sessions s
   WHERE s.session_role IN ('live','replay');

-- Marker clock. at_ms is measured from the recording start of the canonical
-- session; at_webinar_ms from the moment the presenter goes live. The owner
-- reads minutes "into the webinar" from the PROMISED start time, so expose
-- that too.
CREATE OR REPLACE VIEW public.script_marker_clock
WITH (security_invoker = true) AS
  SELECT m.marker_key,
         m.label,
         m.is_offer_moment,
         m.at_ms,
         m.at_webinar_ms,
         m.at_ms + EXTRACT(EPOCH FROM (z.start_time - public.session_t0(z.start_time)))::bigint * 1000
           AS at_promised_ms,
         round((m.at_ms + EXTRACT(EPOCH FROM (z.start_time - public.session_t0(z.start_time)))::bigint * 1000) / 60000.0, 1)
           AS minute_from_promised_start,
         t.id AS transcript_id,
         t.effective_from
    FROM public.script_markers m
    JOIN public.webinar_transcripts t ON t.id = m.transcript_id
    LEFT JOIN public.zoom_sessions z ON z.session_uuid = t.session_ref;

-- Offer consistency is deviation from the SCRIPT's fixed offer minute, not
-- from a rolling average: the video never changes, so a session that differs
-- means the team dropped the payment link late.
CREATE OR REPLACE FUNCTION public.offer_timing_consistency(_from date, _to date)
RETURNS TABLE (
  business_date date,
  session_uuid text,
  script_offer_minute numeric,
  observed_offer_minute numeric,
  deviation_minutes numeric,
  note text
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH script AS (
    SELECT round(min(c.minute_from_promised_start), 1) AS offer_minute
      FROM public.script_marker_clock c
     WHERE c.is_offer_moment
  )
  SELECT s.business_date,
         s.session_uuid,
         script.offer_minute,
         NULL::numeric,
         NULL::numeric,
         'no data — payment-link moment is not captured per session yet'
    FROM public.zoom_sessions s CROSS JOIN script
   WHERE s.session_role IN ('live','replay')
     AND s.business_date BETWEEN _from AND _to
   ORDER BY s.business_date DESC
$$;

-- Contract definitions must state the simulive fact so no future analysis
-- assumes delivery variance between sessions.
UPDATE public.metric_contracts
   SET note = coalesce(note || ' ', '') ||
       'L1 webinars are simulive: the identical pre-recorded video plays every session, so differences between sessions are audience differences, not delivery differences. No host-performance variable exists for L1.',
       updated_at = now()
 WHERE is_current
   AND (metric_id ILIKE '%attend%' OR metric_id ILIKE '%retention%' OR metric_id ILIKE '%show%')
   AND coalesce(note,'') NOT LIKE '%simulive%';