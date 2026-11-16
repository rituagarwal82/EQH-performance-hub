CREATE OR REPLACE FUNCTION public.offer_timing_consistency(_from date, _to date)
 RETURNS TABLE(business_date date, session_uuid text, script_offer_minute numeric, observed_offer_minute numeric, deviation_minutes numeric, note text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH script AS (
    SELECT round(min(m.at_webinar_ms) / 60000.0, 1) AS offer_minute
      FROM public.script_markers m
     WHERE m.is_offer_moment AND m.at_webinar_ms IS NOT NULL
  ), ev AS (
    SELECT t.session_ref, t.actual_start_offset_ms
      FROM public.webinar_transcripts t
     WHERE t.session_ref IS NOT NULL AND t.actual_start_offset_ms IS NOT NULL
  )
  SELECT s.business_date,
         s.session_uuid,
         script.offer_minute,
         CASE WHEN ev.session_ref IS NULL THEN NULL::numeric ELSE
           round(script.offer_minute
                 + extract(epoch FROM (s.start_time + (ev.actual_start_offset_ms || ' milliseconds')::interval
                                       - public.session_t0(s.start_time))) / 60.0, 1) END,
         CASE WHEN ev.session_ref IS NULL THEN NULL::numeric ELSE
           round(extract(epoch FROM (s.start_time + (ev.actual_start_offset_ms || ' milliseconds')::interval
                                     - public.session_t0(s.start_time))) / 60.0, 1) END,
         CASE WHEN ev.session_ref IS NULL
           THEN 'no data — the webinars are pre-recorded, so the offer sits at a fixed point in the video, but we have no evidence of when the video actually started in this session.'
           ELSE 'Pre-recorded script: the offer is fixed in the video, so it only moves by how late or early the video started against the promised time.'
         END
    FROM public.zoom_sessions s
    CROSS JOIN script
    LEFT JOIN ev ON ev.session_ref = s.session_uuid
   WHERE s.session_role IN ('live','replay')
     AND s.business_date BETWEEN _from AND _to
   ORDER BY s.business_date DESC
$function$;