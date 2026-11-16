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
      duration_min, host_email, host_id, total_registrants, total_attendees, business_date,
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
      nullif(r->>'host_id',''),
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
      -- a later listing that omits the host must never erase a resolved one
      host_email = coalesce(excluded.host_email, public.zoom_sessions.host_email),
      host_id = coalesce(excluded.host_id, public.zoom_sessions.host_id),
      total_registrants = coalesce(excluded.total_registrants, public.zoom_sessions.total_registrants),
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

INSERT INTO public.app_settings (key, value, description, updated_at)
VALUES (
  'zoom_host_registry',
  json_build_object(
    'hosts', json_build_object(
      'rituagarwal82@icloud.com', json_build_object('skip', true, 'reason', 'no Webinar licence — skipped', 'probed_at', now(), 'next_probe_at', now() + interval '7 days'),
      'rituagarwal82@gmail.com', json_build_object('skip', true, 'reason', 'no Webinar licence — skipped', 'probed_at', now(), 'next_probe_at', now() + interval '7 days'),
      'community@energyqueenshub.com', json_build_object('skip', true, 'reason', 'no Webinar licence — skipped', 'probed_at', now(), 'next_probe_at', now() + interval '7 days'),
      'connect@healmyfrequency.com', json_build_object('skip', true, 'reason', 'no Webinar licence — skipped', 'probed_at', now(), 'next_probe_at', now() + interval '7 days')
    )
  )::text,
  'Zoom logins skipped by the sync, with the reason and the weekly re-check date. Machine-managed.',
  now()
)
ON CONFLICT (key) DO NOTHING;