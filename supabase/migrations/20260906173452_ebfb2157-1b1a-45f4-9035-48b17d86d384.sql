INSERT INTO public.app_settings (key, value, description)
VALUES ('webinar_slot_times_ist', '10:45,14:45,18:45,19:45',
        'Advertised (promised) webinar slot start times in IST. t0 for all minute-anchored attendance/retention metrics snaps to the nearest of these within 40 minutes of the Zoom room start.')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now();

CREATE OR REPLACE FUNCTION public.session_t0(p_start timestamptz)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  with slots as (
    select trim(x) as hhmm
    from unnest(string_to_array(
      coalesce((select value from public.app_settings where key = 'webinar_slot_times_ist'), '14:45,18:45'), ',')) as x
  ), cand as (
    select (
      ((p_start at time zone 'Asia/Kolkata')::date + s.hhmm::time) at time zone 'Asia/Kolkata'
    ) as t0
    from slots s
  )
  select coalesce(
    (select c.t0 from cand c
      where abs(extract(epoch from (c.t0 - p_start))) <= 2400
      order by abs(extract(epoch from (c.t0 - p_start)))
      limit 1),
    p_start);
$$;

COMMENT ON FUNCTION public.session_t0(timestamptz) IS
'Canonical t0 for minute-anchored attendance/retention: the session''s promised slot start time (advertised slot), never the Zoom room/recording start. Zoom rooms open early with promo videos.';

CREATE OR REPLACE FUNCTION public.zoom_session_rows(p_start date, p_end date, p_include_test boolean DEFAULT false)
RETURNS TABLE(session_uuid text, zoom_id text, session_type text, topic text, start_time timestamptz, business_date date, duration_min integer, total_registrants integer, attendees bigint, invalid_rows bigint, at_30 bigint, at_60 bigint, at_90 bigint, session_role text, topic_date date, event_key text, participants_status text, participants_note text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  select
    s.session_uuid, s.zoom_id, s.session_type, s.topic, s.start_time, s.business_date,
    s.duration_min, s.total_registrants,
    (select count(*) from public.zoom_attendance a where a.session_uuid = s.session_uuid),
    (select count(*) from public.zoom_participants p
      where p.session_uuid = s.session_uuid and p.is_valid = false),
    (select count(*) from public.zoom_attendance a
      where a.session_uuid = s.session_uuid
        and a.first_join <= public.session_t0(s.start_time) + interval '30 minutes'
        and a.last_leave >= public.session_t0(s.start_time) + interval '30 minutes'),
    (select count(*) from public.zoom_attendance a
      where a.session_uuid = s.session_uuid
        and a.first_join <= public.session_t0(s.start_time) + interval '60 minutes'
        and a.last_leave >= public.session_t0(s.start_time) + interval '60 minutes'),
    (select count(*) from public.zoom_attendance a
      where a.session_uuid = s.session_uuid
        and a.first_join <= public.session_t0(s.start_time) + interval '90 minutes'
        and a.last_leave >= public.session_t0(s.start_time) + interval '90 minutes'),
    s.session_role, s.topic_date, s.event_key, s.participants_status, s.participants_note
  from public.zoom_sessions s
  where s.business_date >= p_start and s.business_date <= p_end
    and (p_include_test or s.session_role <> 'test')
  order by s.start_time desc
$$;

CREATE OR REPLACE FUNCTION public.zoom_event_rows(p_start date, p_end date, p_include_test boolean DEFAULT false)
RETURNS TABLE(event_key text, event_date date, sessions bigint, live_sessions bigint, replay_sessions bigint, registrants bigint, attendees bigint, attendees_matched bigint, sessions_without_registrants bigint, at_30 bigint, at_60 bigint, at_90 bigint, sessions_missing_attendance bigint, first_start timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  with s as (
    select * from public.zoom_sessions z
    where z.event_key is not null
      and z.event_key >= to_char(p_start,'YYYY-MM-DD')
      and z.event_key <= to_char(p_end,'YYYY-MM-DD')
      and (p_include_test or z.session_role <> 'test')
  ), per as (
    select
      s.event_key, s.session_uuid, s.start_time, s.session_role,
      case when s.zoom_id is null then s.total_registrants
           when s.session_uuid = (select min(z2.session_uuid) from public.zoom_sessions z2
                                   where z2.zoom_id = s.zoom_id and z2.event_key = s.event_key)
           then s.total_registrants else 0 end as reg,
      s.participants_status,
      (select count(*) from public.zoom_attendance a where a.session_uuid = s.session_uuid) as att,
      (select count(*) from public.zoom_attendance a where a.session_uuid = s.session_uuid
         and a.first_join <= public.session_t0(s.start_time) + interval '30 minutes'
         and a.last_leave >= public.session_t0(s.start_time) + interval '30 minutes') as a30,
      (select count(*) from public.zoom_attendance a where a.session_uuid = s.session_uuid
         and a.first_join <= public.session_t0(s.start_time) + interval '60 minutes'
         and a.last_leave >= public.session_t0(s.start_time) + interval '60 minutes') as a60,
      (select count(*) from public.zoom_attendance a where a.session_uuid = s.session_uuid
         and a.first_join <= public.session_t0(s.start_time) + interval '90 minutes'
         and a.last_leave >= public.session_t0(s.start_time) + interval '90 minutes') as a90
    from s
  )
  select
    per.event_key,
    per.event_key::date,
    count(*)::bigint,
    count(*) filter (where per.session_role = 'live')::bigint,
    count(*) filter (where per.session_role = 'replay')::bigint,
    coalesce(sum(per.reg),0)::bigint,
    coalesce(sum(per.att),0)::bigint,
    coalesce(sum(per.att) filter (where coalesce(per.reg,0) > 0),0)::bigint,
    count(*) filter (where coalesce(per.reg,0) = 0)::bigint,
    coalesce(sum(per.a30),0)::bigint,
    coalesce(sum(per.a60),0)::bigint,
    coalesce(sum(per.a90),0)::bigint,
    count(*) filter (where per.participants_status in ('failed','unavailable'))::bigint,
    min(per.start_time)
  from per
  group by per.event_key
  order by per.event_key desc
$$;