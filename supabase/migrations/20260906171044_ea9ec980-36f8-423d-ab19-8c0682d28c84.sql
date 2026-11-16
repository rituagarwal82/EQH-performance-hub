create table if not exists public.zoom_recordings (
  id uuid primary key default gen_random_uuid(),
  session_ref text not null,
  recording_id text,
  recording_type text not null,
  file_extension text,
  file_size bigint,
  download_url text,
  play_url text,
  url_expires_at timestamp with time zone,
  recorded_at timestamp with time zone,
  recording_start timestamp with time zone,
  recording_end timestamp with time zone,
  storage_path text,
  status text not null default 'pending',
  note text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (session_ref, recording_id)
);

grant select on public.zoom_recordings to authenticated;
grant all on public.zoom_recordings to service_role;
alter table public.zoom_recordings enable row level security;
create policy "Authenticated can read zoom_recordings" on public.zoom_recordings
  for select to authenticated using (true);
create policy "Service role manages zoom_recordings" on public.zoom_recordings
  for all to service_role using (true) with check (true);

create index if not exists zoom_recordings_session_idx on public.zoom_recordings (session_ref);
create index if not exists zoom_recordings_status_idx on public.zoom_recordings (status);

create trigger zoom_recordings_touch
  before update on public.zoom_recordings
  for each row execute function public.update_updated_at_column();

alter table public.zoom_sessions add column if not exists host_id text;

create table if not exists public.experiment_assignments (
  id uuid primary key default gen_random_uuid(),
  lead_ref text not null,
  experiment_key text not null,
  variant text not null,
  assigned_at timestamp with time zone not null default now(),
  note text,
  unique (lead_ref, experiment_key)
);

grant select on public.experiment_assignments to authenticated;
grant all on public.experiment_assignments to service_role;
alter table public.experiment_assignments enable row level security;
create policy "Authenticated can read experiment_assignments" on public.experiment_assignments
  for select to authenticated using (true);
create policy "Service role manages experiment_assignments" on public.experiment_assignments
  for all to service_role using (true) with check (true);

create index if not exists experiment_assignments_key_idx on public.experiment_assignments (experiment_key);