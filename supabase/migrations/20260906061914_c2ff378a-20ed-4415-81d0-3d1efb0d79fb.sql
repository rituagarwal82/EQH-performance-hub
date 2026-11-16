-- ═══ STEP 2 — CRON MANIFEST + DRIFT / ALIVE CHECKS ═══

create table if not exists public.cron_manifest (
  jobname text primary key,
  schedule text not null,
  url_path text not null,
  body jsonb not null default '{}'::jsonb,
  max_gap_hours numeric not null default 24,
  active boolean not null default true,
  note text,
  updated_at timestamptz not null default now()
);

grant select on public.cron_manifest to authenticated;
grant all on public.cron_manifest to service_role;
alter table public.cron_manifest enable row level security;
drop policy if exists "manifest readable by authenticated" on public.cron_manifest;
create policy "manifest readable by authenticated" on public.cron_manifest
  for select to authenticated using (true);
drop policy if exists "manifest writable by service role" on public.cron_manifest;
create policy "manifest writable by service role" on public.cron_manifest
  for all to service_role using (true) with check (true);

insert into public.cron_manifest (jobname, schedule, url_path, body, max_gap_hours) values
  ('sync-meta-daily',              '30 3 * * *',        '/api/public/cron/sync-meta',          '{}',                24),
  ('sync-ledger-daily',            '40 4 * * *',        '/api/public/sync-ledger',             '{"refresh":true}',  24),
  ('sync-tagmango-payments-daily', '20 5 * * *',        '/api/public/sync-tagmango-payments',  '{"passes":6}',      24),
  ('rebuild-baselines-daily',      '40 5 * * *',        '/api/public/cron/rebuild-baselines',  '{}',                24),
  ('sync-ghl-leads-6h',            '5 */6 * * *',       '/api/public/cron/sync-ghl-leads',     '{"days":3}',         6),
  ('sync-tagmango-products-weekly','50 5 * * 1',        '/api/public/sync-tagmango-products',  '{}',               168),
  ('sync-zoom-4x',                 '0 11,13,16,23 * * *','/api/public/cron/sync-zoom',         '{}',                12),
  ('run-proof-daily',              '10 6 * * *',        '/api/public/cron/run-proof',          '{}',                24),
  ('run-analyst-daily',            '30 6 * * *',        '/api/public/cron/run-analyst',        '{}',                24),
  ('sync-creative-daily',          '15 4 * * *',        '/api/public/cron/sync-creative',      '{}',                24),
  ('tag-scripts-daily',            '20 4 * * *',        '/api/public/cron/tag-scripts',        '{}',                24),
  ('creative-weekly-monday',       '45 6 * * 1',        '/api/public/cron/creative-weekly',    '{}',               168),
  ('creative-brief-fortnightly',   '50 6 * * *',        '/api/public/cron/creative-brief',     '{}',                24)
on conflict (jobname) do update set
  schedule = excluded.schedule, url_path = excluded.url_path, body = excluded.body,
  max_gap_hours = excluded.max_gap_hours, updated_at = now();

/**
 * Manifest vs what is actually deployed. The last arm is the tombstone of the
 * extensions.http_post incident: a job that no longer calls net.http_post is a
 * fault whatever else it looks like.
 */
create or replace function public.inv_cron_manifest_rows()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_missing text[]; v_extra text[]; v_sched text[]; v_url text[]; v_tomb text[];
  v_problems text[]; v_expected int; v_ok int;
begin
  select array_agg(m.jobname order by m.jobname) into v_missing
    from cron_manifest m
   where m.active and not exists (select 1 from cron.job j where j.jobname = m.jobname);

  select array_agg(j.jobname order by j.jobname) into v_extra
    from cron.job j
   where not exists (select 1 from cron_manifest m where m.jobname = j.jobname and m.active);

  select array_agg(j.jobname || ': scheduled ' || j.schedule || ', manifest says ' || m.schedule
                   order by j.jobname) into v_sched
    from cron.job j join cron_manifest m on m.jobname = j.jobname and m.active
   where btrim(j.schedule) <> btrim(m.schedule);

  select array_agg(j.jobname || ': deployed command does not call ' || m.url_path order by j.jobname)
    into v_url
    from cron.job j join cron_manifest m on m.jobname = j.jobname and m.active
   where position(m.url_path in j.command) = 0;

  select array_agg(j.jobname || ': command does not call net.http_post' order by j.jobname)
    into v_tomb
    from cron.job j
   where j.command !~ 'net\.http_post';

  v_problems := coalesce(
    (select array_agg(x) from (
       select unnest(coalesce(v_missing, '{}')) || ' is in the manifest but not scheduled' as x
       union all select unnest(coalesce(v_extra, '{}')) || ' is scheduled but not in the manifest'
       union all select unnest(coalesce(v_sched, '{}'))
       union all select unnest(coalesce(v_url, '{}'))
       union all select unnest(coalesce(v_tomb, '{}'))
     ) t), '{}');

  select count(*)::int into v_expected from cron_manifest where active;
  v_ok := v_expected - coalesce(array_length(v_missing, 1), 0);

  return jsonb_build_array(jsonb_build_object(
    'check_id','inv_cron_manifest',
    'checked_at', now(),
    'for_date', current_date,
    'primary_value', v_expected,
    'primary_source','Scheduled jobs as the manifest declares them',
    'witness_value', v_ok,
    'witness_source','Jobs actually scheduled in the database right now',
    'divergence_pct', case when v_expected = 0 then 0 else round(100.0*(v_ok - v_expected)/v_expected, 2) end,
    'verdict', case when coalesce(array_length(v_problems,1),0) = 0 then 'match' else 'diverged' end,
    'note', case when coalesce(array_length(v_problems,1),0) = 0
                 then v_expected || ' scheduled jobs match the manifest exactly, and every one of them still calls out over the network.'
                 else array_to_string(v_problems, ' · ') end
  ));
end $$;

/** A job that fires and fails forever is not alive. */
create or replace function public.inv_cron_alive_rows()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_total int; v_alive int; v_dead text[];
begin
  select count(*)::int into v_total from cron_manifest where active;

  select array_agg(m.jobname || ' (nothing succeeded in ' || (m.max_gap_hours*2)::text || 'h)' order by m.jobname)
    into v_dead
    from cron_manifest m
    join cron.job j on j.jobname = m.jobname
   where m.active
     and not exists (
       select 1 from cron.job_run_details d
        where d.jobid = j.jobid and d.status = 'succeeded'
          and d.start_time > now() - (m.max_gap_hours * 2 || ' hours')::interval
     );

  v_alive := v_total - coalesce(array_length(v_dead, 1), 0);

  return jsonb_build_array(jsonb_build_object(
    'check_id','inv_cron_alive',
    'checked_at', now(),
    'for_date', current_date,
    'primary_value', v_total,
    'primary_source','Active jobs in the manifest',
    'witness_value', v_alive,
    'witness_source','Jobs with a completed run inside twice their own interval',
    'divergence_pct', case when v_total = 0 then 0 else round(100.0*(v_alive - v_total)/v_total, 2) end,
    'verdict', case when coalesce(array_length(v_dead,1),0) = 0 then 'match' else 'diverged' end,
    'note', case when coalesce(array_length(v_dead,1),0) = 0
                 then 'All ' || v_total || ' scheduled jobs have completed at least once recently.'
                 else 'These jobs are firing but never completing: ' || array_to_string(v_dead, ' · ') end
  ));
end $$;

revoke execute on function public.inv_cron_manifest_rows() from anon, authenticated;
revoke execute on function public.inv_cron_alive_rows() from anon, authenticated;
grant execute on function public.inv_cron_manifest_rows() to service_role;
grant execute on function public.inv_cron_alive_rows() to service_role;

-- ═══ STEP 3 — SEMANTIC INVARIANTS ═══

create table if not exists public.feed_edge_history (
  feed text not null,
  observed_at timestamptz not null default now(),
  coverage_edge date,
  primary key (feed, observed_at)
);
grant select on public.feed_edge_history to authenticated;
grant all on public.feed_edge_history to service_role;
alter table public.feed_edge_history enable row level security;
drop policy if exists "edge history readable" on public.feed_edge_history;
create policy "edge history readable" on public.feed_edge_history
  for select to authenticated using (true);
drop policy if exists "edge history writable by service role" on public.feed_edge_history;
create policy "edge history writable by service role" on public.feed_edge_history
  for all to service_role using (true) with check (true);

-- A feed can be forced to read stale by an invariant, independently of its sync.
alter table public.feed_config
  add column if not exists forced_stale_reason text,
  add column if not exists forced_stale_at timestamptz;