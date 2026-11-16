-- V5: the per-session attendance counts were four correlated subqueries over
-- zoom_attendance, so cost grew with sessions x scans. One grouped pass instead.
CREATE OR REPLACE FUNCTION public.zoom_event_rows(p_start date, p_end date, p_include_test boolean DEFAULT false)
 RETURNS TABLE(event_key text, event_date date, sessions bigint, live_sessions bigint, replay_sessions bigint, registrants bigint, attendees bigint, attendees_matched bigint, sessions_without_registrants bigint, at_30 bigint, at_60 bigint, at_90 bigint, sessions_missing_attendance bigint, first_start timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
  with s as materialized (
    select z.event_key, z.session_uuid, z.zoom_id, z.start_time, z.session_role,
           z.total_registrants, z.participants_status
      from public.zoom_sessions z
     where z.event_key is not null
       and z.event_key >= to_char(p_start,'YYYY-MM-DD')
       and z.event_key <= to_char(p_end,'YYYY-MM-DD')
       and (p_include_test or z.session_role <> 'test')
  ),
  dedup as (
    -- a rejoined session repeats its registrant count; only the first row keeps it
    select s.session_uuid,
           case when s.zoom_id is null then s.total_registrants
                when s.session_uuid = min(s.session_uuid) over (partition by s.zoom_id, s.event_key)
                then s.total_registrants else 0 end as reg
      from s
  ),
  att as materialized (
    select a.session_uuid,
           count(*) as att,
           count(*) filter (where a.first_join <= public.session_t0(s.start_time) + interval '30 minutes'
                              and a.last_leave >= public.session_t0(s.start_time) + interval '30 minutes') as a30,
           count(*) filter (where a.first_join <= public.session_t0(s.start_time) + interval '60 minutes'
                              and a.last_leave >= public.session_t0(s.start_time) + interval '60 minutes') as a60,
           count(*) filter (where a.first_join <= public.session_t0(s.start_time) + interval '90 minutes'
                              and a.last_leave >= public.session_t0(s.start_time) + interval '90 minutes') as a90
      from s
      join public.zoom_attendance a on a.session_uuid = s.session_uuid
     group by a.session_uuid
  ),
  per as (
    select s.event_key, s.start_time, s.session_role, s.participants_status,
           d.reg,
           coalesce(t.att,0) as att, coalesce(t.a30,0) as a30,
           coalesce(t.a60,0) as a60, coalesce(t.a90,0) as a90
      from s
      join dedup d on d.session_uuid = s.session_uuid
      left join att t on t.session_uuid = s.session_uuid
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
$function$;

CREATE INDEX IF NOT EXISTS zoom_participants_session_valid_idx
  ON public.zoom_participants (session_uuid) WHERE is_valid;

ANALYZE public.zoom_participants;