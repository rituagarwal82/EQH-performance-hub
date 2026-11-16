-- ============ permanent versions of the by-hand fixes ============
CREATE INDEX IF NOT EXISTS leads_email_captured_idx
  ON public.leads (email_key, captured_at)
  WHERE email_key IS NOT NULL AND email_key <> '';

ANALYZE public.leads;
ANALYZE public.ledger_inflow;
ANALYZE public.zoom_sessions;
ANALYZE public.zoom_participants;

-- ============ C3: log every scheduled web call, scoped to cron ============
CREATE TABLE IF NOT EXISTS public.cron_http_calls (
  request_id bigint PRIMARY KEY,
  jobname text NOT NULL,
  url text NOT NULL,
  called_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.cron_http_calls TO authenticated;
GRANT ALL ON public.cron_http_calls TO service_role;
ALTER TABLE public.cron_http_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cron calls readable" ON public.cron_http_calls;
CREATE POLICY "cron calls readable" ON public.cron_http_calls FOR SELECT TO authenticated USING (true);
CREATE INDEX IF NOT EXISTS cron_http_calls_called_idx ON public.cron_http_calls (called_at DESC);

ALTER TABLE public.cron_manifest
  ADD COLUMN IF NOT EXISTS timeout_ms integer NOT NULL DEFAULT 600000;

UPDATE public.cron_manifest SET timeout_ms = 900000
 WHERE jobname IN ('sync-ledger-daily','sync-meta-daily','sync-zoom-4x',
                   'sync-tagmango-payments-daily','sync-creative-daily');
UPDATE public.cron_manifest SET timeout_ms = 600000
 WHERE jobname IN ('creative-weekly-monday','creative-brief-fortnightly','tag-scripts-daily');

INSERT INTO public.app_settings (key, value, description)
VALUES ('cron_base_url',
        'https://project--99936e18-5a56-46c8-ac3a-3a284371d25c-dev.lovable.app',
        'Base URL every scheduled job posts to.')
ON CONFLICT (key) DO NOTHING;

-- One sender for every scheduled job: builds the call from the manifest,
-- records the request id so the alarm can tell a cron call from any other.
CREATE OR REPLACE FUNCTION public.cron_post(p_jobname text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
declare m record; v_base text; v_url text; v_id bigint;
begin
  select * into m from public.cron_manifest where jobname = p_jobname;
  if not found then raise exception 'no manifest row for %', p_jobname; end if;
  select value into v_base from public.app_settings where key = 'cron_base_url';
  v_url := v_base || m.url_path;
  select net.http_post(
    url := v_url,
    body := m.body,
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey','sb_publishable_Qpz-q-wnabARLmEczwKC8A_1PEwMEJS'),
    timeout_milliseconds := m.timeout_ms) into v_id;
  insert into public.cron_http_calls (request_id, jobname, url)
  values (v_id, p_jobname, v_url)
  on conflict (request_id) do nothing;
  return v_id;
end
$fn$;

-- ============ C5 scheduling: the close pass must actually run ============
INSERT INTO public.cron_manifest (jobname, schedule, url_path, body, max_gap_hours, active, note, timeout_ms)
VALUES ('verify-queue-daily', '0 7 * * *', '/api/public/cron/verify-queue', '{}'::jsonb, 30, true,
        'Re-tests every open review item and closes the ones that now pass, with evidence.', 600000)
ON CONFLICT (jobname) DO UPDATE
  SET schedule = excluded.schedule, url_path = excluded.url_path, body = excluded.body,
      max_gap_hours = excluded.max_gap_hours, active = true, timeout_ms = excluded.timeout_ms;

-- ============ C4 + C3: reschedule every active job through the sender ============
DO $do$
declare m record;
begin
  for m in select jobname, schedule from public.cron_manifest where active loop
    perform cron.schedule(m.jobname, m.schedule,
      format('select public.cron_post(%L)', m.jobname));
  end loop;
end
$do$;

-- ============ C3: coherent cron alarm ============
CREATE OR REPLACE FUNCTION public.inv_cron_alive_rows()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
declare v_total int; v_alive int; v_dead text[]; v_pending text[];
        v_calls int; v_bad int; v_note text;
begin
  select count(*)::int into v_total from cron_manifest where active;

  select array_agg(m.jobname order by m.jobname) into v_pending
    from cron_manifest m
    join cron.job j on j.jobname = m.jobname
   where m.active
     and m.first_seen_at > now() - (m.max_gap_hours || ' hours')::interval
     and not exists (select 1 from cron.job_run_details d
                      where d.jobid = j.jobid and d.status = 'succeeded');

  select array_agg(
           m.jobname ||
           case when not exists (select 1 from cron.job_run_details d2
                                  where d2.jobid = j.jobid and d2.status = 'succeeded')
                then ' (has never completed a run)'
                else ' (nothing completed in ' || (m.max_gap_hours*2)::text || 'h)' end
           order by m.jobname)
    into v_dead
    from cron_manifest m
    join cron.job j on j.jobname = m.jobname
   where m.active
     and not (m.first_seen_at > now() - (m.max_gap_hours || ' hours')::interval
              and not exists (select 1 from cron.job_run_details d3
                               where d3.jobid = j.jobid and d3.status = 'succeeded'))
     and not exists (
       select 1 from cron.job_run_details d
        where d.jobid = j.jobid and d.status = 'succeeded'
          and d.start_time > now() - (m.max_gap_hours * 2 || ' hours')::interval
     );

  -- Only this project's OWN scheduled calls count. Anything else that used
  -- pg_net is not a scheduled job and must not raise a scheduling alarm.
  select count(*)::int,
         count(*) filter (where r.status_code is null or r.status_code >= 300)::int
    into v_calls, v_bad
    from cron_http_calls c
    join net._http_response r on r.id = c.request_id
   where c.called_at > now() - interval '24 hours';

  v_alive := v_total - coalesce(array_length(v_dead,1),0) - coalesce(array_length(v_pending,1),0);

  v_note := case when coalesce(array_length(v_dead,1),0) = 0
                 then 'All ' || v_alive || ' due scheduled jobs have completed at least once recently.'
                 else 'These jobs are not completing: ' || array_to_string(v_dead, ' · ') end
         || case when coalesce(array_length(v_pending,1),0) > 0
                 then ' Not due yet: ' || array_to_string(v_pending, ' · ') || '.' else '' end;

  return jsonb_build_array(
    jsonb_build_object(
      'check_id','inv_cron_alive',
      'checked_at', now(),
      'for_date', current_date,
      'primary_value', v_total,
      'primary_source','Active jobs in the manifest',
      'witness_value', v_alive,
      'witness_source','Jobs due and completed inside twice their own interval',
      'divergence_pct', case when v_total = 0 then 0 else round(100.0*(v_alive - v_total)/v_total, 2) end,
      'verdict', case when coalesce(array_length(v_dead,1),0) = 0 then 'match' else 'diverged' end,
      'note', v_note),
    jsonb_build_object(
      'check_id','inv_cron_call_accepted',
      'checked_at', now(),
      'for_date', current_date,
      'primary_value', v_calls,
      'primary_source','Scheduled web calls sent in the last 24 hours',
      'witness_value', v_calls - v_bad,
      'witness_source','Those the site accepted',
      'divergence_pct', case when v_calls = 0 then 0 else round(-100.0*v_bad/v_calls, 2) end,
      'verdict', case when v_bad = 0 then 'match' else 'diverged' end,
      'note', case when v_calls = 0
        then 'No scheduled web call has been sent in the last 24 hours yet.'
        when v_bad = 0 then 'All ' || v_calls || ' scheduled web call(s) were accepted.'
        else v_bad || ' of ' || v_calls || ' scheduled web call(s) were rejected or timed out.' end)
  );
end
$fn$;

INSERT INTO public.proof_registry
  (check_id, family, label, plain, expected_noise, fp_budget_per_30d, tolerance_note, structural_note, enabled, needs_recalibration, ord)
VALUES ('inv_cron_call_accepted','invariant','Scheduled web calls are accepted',
        'Every call a scheduled job sends must be accepted by the site. A rejected or timed-out call means the job fired and did nothing.',
        'Rare. One rejection during a deploy is plausible.', 2,
        'Counts only calls this project''s own scheduler sent in the last 24 hours.', '', true, false, 12)
ON CONFLICT (check_id) DO UPDATE
  SET label = excluded.label, plain = excluded.plain, enabled = true;

-- ============ C2 + H4: patch the two invariant arms in place ============
DO $do$
declare src text;
begin
  select prosrc into src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'run_invariants' and n.nspname = 'public';

  -- C2: a part-finished day never adds up. Only check days that have ended (IST).
  src := replace(src,
    'if v_a > 0 or v_c > 0 then',
    'if (v_a > 0 or v_c > 0) and d < (now() at time zone ''Asia/Kolkata'')::date then');

  -- H4: a live-slot registrant attending the replay is structurally normal.
  src := replace(src,
    'and z.total_attendees > z.total_registrants;',
    'and z.total_attendees > z.total_registrants and coalesce(z.session_role, ''live'') <> ''replay'';');

  if position('Asia/Kolkata' in src) = 0 then
    raise exception 'C2 guard did not apply — run_invariants body changed';
  end if;
  if position('session_role' in src) = 0 then
    raise exception 'H4 replay exclusion did not apply — run_invariants body changed';
  end if;

  execute format(
    'create or replace function public.run_invariants(p_start date, p_end date) returns jsonb language plpgsql security definer set search_path to ''public'' as %L',
    src);
end
$do$;

-- ============ H1: August closed, and month-closing made automatic ============
UPDATE public.app_settings
   SET value = (coalesce(value,'{}')::jsonb || '{"2026-08":196}'::jsonb)::text,
       updated_at = now()
 WHERE key = 'ledger_baseline_monthly';

CREATE OR REPLACE FUNCTION public.close_finished_months()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
declare v_base jsonb; v_month text; v_count int; v_added text[] := '{}';
begin
  select coalesce(value,'{}')::jsonb into v_base
    from app_settings where key = 'ledger_baseline_monthly';

  -- A month closes only once it has fully ended and had five days to settle.
  for v_month in
    select to_char(m, 'YYYY-MM')
      from generate_series(date '2026-01-01',
                           date_trunc('month', (now() at time zone 'Asia/Kolkata')::date) - interval '1 month',
                           interval '1 month') m
     where m < date_trunc('month', (now() at time zone 'Asia/Kolkata')::date - interval '5 days')
     order by m
  loop
    if v_base ? v_month then continue; end if;
    select count(*) filter (where counts_as_sale)::int into v_count
      from ledger_inflow
     where product_tier = 'L1_SILVER' and to_char(business_date, 'YYYY-MM') = v_month;
    if v_count > 0 then
      v_base := v_base || jsonb_build_object(v_month, v_count);
      v_added := v_added || v_month;
    end if;
  end loop;

  update app_settings set value = v_base::text, updated_at = now()
   where key = 'ledger_baseline_monthly';

  return jsonb_build_object('closed_now', to_jsonb(v_added), 'baseline', v_base);
end
$fn$;

SELECT cron.schedule('close-month-monthly', '10 2 5 * *',
  $$select public.close_finished_months()$$);

-- ============ M1: the recordings feed becomes visible ============
INSERT INTO public.feed_config (feed, label, cadence_hours, is_blocking, sources, note)
VALUES ('recordings','Zoom recordings & transcripts', 3, false,
        ARRAY['zoom-recordings','zoom-recordings-cron','capture-recordings'],
        'Hourly capture of Zoom cloud recordings and their transcripts.')
ON CONFLICT (feed) DO UPDATE
  SET sources = excluded.sources, cadence_hours = excluded.cadence_hours, label = excluded.label;

-- ============ M6: owner-actionable, not a recurring feed error ============
INSERT INTO public.review_items (kind, ref_id, title, detail, evidence, status)
SELECT 'owner_action', 'zoom_webinar_licences',
       'Four Zoom hosts have no webinar licence',
       'Sessions hosted by these accounts cannot report registrants or attendance: rituagarwal82@icloud.com, rituagarwal82@gmail.com, community@energyqueenshub.com, connect@healmyfrequency.com. Either move the sessions to a licensed host or add licences.',
       jsonb_build_object('hosts', jsonb_build_array('rituagarwal82@icloud.com','rituagarwal82@gmail.com','community@energyqueenshub.com','connect@healmyfrequency.com')),
       'open'
WHERE NOT EXISTS (
  SELECT 1 FROM public.review_items
   WHERE kind = 'owner_action' AND ref_id = 'zoom_webinar_licences' AND status = 'open');