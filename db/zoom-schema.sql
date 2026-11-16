-- Zoom integration: settings, sessions, participants, attendance view, rollups.

create table if not exists public.app_settings (
  key text primary key,
  value text,
  description text,
  updated_at timestamptz not null default now()
);

grant select, update on public.app_settings to authenticated;
grant all on public.app_settings to service_role;
alter table public.app_settings enable row level security;
create policy "Authenticated can read app_settings" on public.app_settings
  for select to authenticated using (true);
create policy "Authenticated can edit app_settings" on public.app_settings
  for update to authenticated using (true) with check (true);
create policy "Service role manages app_settings" on public.app_settings
  for all to service_role using (true) with check (true);

insert into public.app_settings (key, value, description) values
  ('zoom_l1_topic_match', 'become the energy queen',
   'Case-insensitive substring that identifies an L1 webinar session in the Zoom topic. Sessions not matching this are ignored.')
on conflict (key) do nothing;

-- Business day: 06:00–05:59 IST, attributed to the day the session started.
create or replace function public.business_date(p_ts timestamptz)
returns date
language sql
immutable
set search_path = public
as $$
  select (((p_ts at time zone 'Asia/Kolkata') - interval '6 hours'))::date
$$;

create table if not exists public.zoom_sessions (
  session_uuid text primary key,
  zoom_id text,
  session_type text not null check (session_type in ('webinar','meeting')),
  topic text,
  start_time timestamptz,
  end_time timestamptz,
  duration_min integer,
  host_email text,
  total_registrants integer,
  total_attendees integer,
  business_date date,
  synced_at timestamptz not null default now()
);

grant select on public.zoom_sessions to authenticated;
grant all on public.zoom_sessions to service_role;
alter table public.zoom_sessions enable row level security;
create policy "Authenticated can read zoom_sessions" on public.zoom_sessions
  for select to authenticated using (true);
create policy "Service role manages zoom_sessions" on public.zoom_sessions
  for all to service_role using (true) with check (true);

create index if not exists zoom_sessions_business_date_idx on public.zoom_sessions (business_date desc);
create index if not exists zoom_sessions_zoom_id_idx on public.zoom_sessions (zoom_id);

create table if not exists public.zoom_participants (
  id uuid primary key default gen_random_uuid(),
  session_uuid text references public.zoom_sessions(session_uuid) on delete cascade,
  participant_id text,
  name text,
  email text,
  join_time timestamptz,
  leave_time timestamptz,
  duration_sec integer,
  is_valid boolean not null default true,
  invalid_reason text,
  unique (session_uuid, participant_id, join_time)
);

grant select on public.zoom_participants to authenticated;
grant all on public.zoom_participants to service_role;
alter table public.zoom_participants enable row level security;
create policy "Authenticated can read zoom_participants" on public.zoom_participants
  for select to authenticated using (true);
create policy "Service role manages zoom_participants" on public.zoom_participants
  for all to service_role using (true) with check (true);

create index if not exists zoom_participants_session_idx on public.zoom_participants (session_uuid);

-- Rejoins collapsed: ONE row per person per session, valid segments only.
create or replace view public.zoom_attendance
with (security_invoker = true) as
  select
    p.session_uuid,
    coalesce(nullif(lower(p.email), ''), p.participant_id) as person_key,
    min(p.name) as name,
    min(nullif(lower(p.email), '')) as email,
    sum(greatest(coalesce(p.duration_sec, 0), 0))::bigint as total_duration_sec,
    min(p.join_time) as first_join,
    max(p.leave_time) as last_leave,
    count(*)::int as segments
  from public.zoom_participants p
  where p.is_valid
  group by p.session_uuid, coalesce(nullif(lower(p.email), ''), p.participant_id);

grant select on public.zoom_attendance to authenticated;
grant select on public.zoom_attendance to service_role;

-- Session table for /webinars, with retention at 30 / 60 / 90 minutes.
create or replace function public.zoom_session_rows(p_start date, p_end date)
returns table (
  session_uuid text,
  zoom_id text,
  session_type text,
  topic text,
  start_time timestamptz,
  business_date date,
  duration_min integer,
  total_registrants integer,
  attendees bigint,
  invalid_rows bigint,
  at_30 bigint,
  at_60 bigint,
  at_90 bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.session_uuid,
    s.zoom_id,
    s.session_type,
    s.topic,
    s.start_time,
    s.business_date,
    s.duration_min,
    s.total_registrants,
    (select count(*) from public.zoom_attendance a where a.session_uuid = s.session_uuid),
    (select count(*) from public.zoom_participants p
      where p.session_uuid = s.session_uuid and p.is_valid = false),
    -- Retention is measured from the PROMISED start time (session_t0), never the
    -- room-open time: rooms open 15-25 minutes early with promo video.
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
        and a.last_leave >= public.session_t0(s.start_time) + interval '90 minutes')

  from public.zoom_sessions s
  where s.business_date >= p_start and s.business_date <= p_end
  order by s.start_time desc
$$;

-- Retention curve for one session: attendees present at each 5-minute mark.
create or replace function public.zoom_retention_curve(p_session_uuid text)
returns table (minute integer, present bigint)
language sql
stable
security definer
set search_path = public
as $$
  with s as (
    select public.session_t0(start_time) as start_time, greatest(coalesce(duration_min, 0), 5) as dur
    from public.zoom_sessions where session_uuid = p_session_uuid
  ), marks as (
    select generate_series(0, (select dur from s), 5) as minute
  )
  select
    m.minute::int,
    (select count(*) from public.zoom_attendance a, s
      where a.session_uuid = p_session_uuid
        and a.first_join <= s.start_time + (m.minute || ' minutes')::interval
        and a.last_leave >= s.start_time + (m.minute || ' minutes')::interval)

  from marks m
  order by m.minute
$$;

revoke all on function public.zoom_session_rows(date, date) from public;
revoke all on function public.zoom_retention_curve(text) from public;
grant execute on function public.zoom_session_rows(date, date) to service_role;
grant execute on function public.zoom_retention_curve(text) to service_role;

-- Bulk upserts used by the sync -----------------------------------------------

create or replace function public.upsert_zoom_sessions(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  with upserted as (
    insert into public.zoom_sessions (
      session_uuid, zoom_id, session_type, topic, start_time, end_time,
      duration_min, host_email, total_registrants, total_attendees, business_date, synced_at)
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
      total_attendees = coalesce(excluded.total_attendees, public.zoom_sessions.total_attendees),
      business_date = excluded.business_date,
      synced_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;
  return v_count;
end;
$$;

create or replace function public.upsert_zoom_participants(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  with upserted as (
    insert into public.zoom_participants (
      session_uuid, participant_id, name, email, join_time, leave_time,
      duration_sec, is_valid, invalid_reason)
    select
      r->>'session_uuid',
      r->>'participant_id',
      nullif(r->>'name',''),
      nullif(r->>'email',''),
      nullif(r->>'join_time','')::timestamptz,
      nullif(r->>'leave_time','')::timestamptz,
      nullif(r->>'duration_sec','')::int,
      coalesce((r->>'is_valid')::boolean, true),
      nullif(r->>'invalid_reason','')
    from jsonb_array_elements(p_rows) as r
    on conflict (session_uuid, participant_id, join_time) do update set
      name = excluded.name,
      email = excluded.email,
      leave_time = excluded.leave_time,
      duration_sec = excluded.duration_sec,
      is_valid = excluded.is_valid,
      invalid_reason = excluded.invalid_reason
    returning 1
  )
  select count(*) into v_count from upserted;
  return v_count;
end;
$$;

revoke all on function public.upsert_zoom_sessions(jsonb) from public;
revoke all on function public.upsert_zoom_participants(jsonb) from public;
grant execute on function public.upsert_zoom_sessions(jsonb) to service_role;
grant execute on function public.upsert_zoom_participants(jsonb) to service_role;
