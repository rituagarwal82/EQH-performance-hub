create table if not exists public.zoom_ignored_sessions (
  session_uuid text primary key,
  zoom_id text,
  session_type text,
  topic text,
  start_time timestamptz,
  host_email text,
  business_date date,
  seen_at timestamptz not null default now()
);

grant select on public.zoom_ignored_sessions to authenticated;
grant all on public.zoom_ignored_sessions to service_role;
alter table public.zoom_ignored_sessions enable row level security;
create policy "Authenticated can read zoom_ignored_sessions" on public.zoom_ignored_sessions
  for select to authenticated using (true);
create policy "Service role manages zoom_ignored_sessions" on public.zoom_ignored_sessions
  for all to service_role using (true) with check (true);

create index if not exists zoom_ignored_start_idx on public.zoom_ignored_sessions (start_time desc);