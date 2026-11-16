INSERT INTO public.app_settings (key, value, description)
VALUES (
  'zoom_topic_rules',
  '{"replay_words":["replay"],"test_words":["test","testing","dummy"],"date_patterns":["dd-mm-yyyy","dd-mm-yy","dd/mm/yyyy","written"],"replay_offset_days":1}',
  'Topic normalisation rules for Zoom sessions: words that mark a replay or a test, and how many days before the replay the live session ran. Edited by the owner; read on every sync.'
)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.upsert_zoom_sessions(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_count integer;
begin
  with upserted as (
    insert into public.zoom_sessions (
      session_uuid, zoom_id, session_type, topic, start_time, end_time,
      duration_min, host_email, total_registrants, total_attendees, business_date,
      participants_status, participants_note, session_role, topic_date, event_key, synced_at)
    select
      r->>'session_uuid',
      nullif(r->>'zoom_id',''),
      r->>'session_type',
      r->>'topic',
      (r->>'start_time')::timestamptz,
      nullif(r->>'end_time','')::timestamptz,
      nullif(r->>'duration_min','')::int,
      nullif(r->>'host_email',''),
      nullif(r->>'total_registrants','')::int,
      nullif(r->>'total_attendees','')::int,
      public.business_date((r->>'start_time')::timestamptz),
      nullif(r->>'participants_status',''),
      nullif(r->>'participants_note',''),
      nullif(r->>'session_role',''),
      nullif(r->>'topic_date','')::date,
      nullif(r->>'event_key',''),
      now()
    from jsonb_array_elements(p_rows) as r
    on conflict (session_uuid) do update set
      zoom_id = excluded.zoom_id,
      session_type = excluded.session_type,
      topic = excluded.topic,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      duration_min = excluded.duration_min,
      host_email = excluded.host_email,
      total_registrants = coalesce(excluded.total_registrants, public.zoom_sessions.total_registrants),
      -- never overwrite a real attendee count with a null from a failed fetch
      total_attendees = case
        when excluded.participants_status in ('failed','unavailable')
          then coalesce(public.zoom_sessions.total_attendees, excluded.total_attendees)
        else coalesce(excluded.total_attendees, public.zoom_sessions.total_attendees)
      end,
      business_date = excluded.business_date,
      participants_status = coalesce(excluded.participants_status, public.zoom_sessions.participants_status),
      participants_note = excluded.participants_note,
      session_role = coalesce(excluded.session_role, public.zoom_sessions.session_role),
      topic_date = coalesce(excluded.topic_date, public.zoom_sessions.topic_date),
      event_key = coalesce(excluded.event_key, public.zoom_sessions.event_key),
      synced_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;
  return v_count;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.upsert_zoom_sessions(jsonb) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.upsert_zoom_sessions(jsonb) TO service_role;