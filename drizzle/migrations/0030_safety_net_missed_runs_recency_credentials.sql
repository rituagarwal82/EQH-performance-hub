-- "NOTHING STOPS SILENTLY" SAFETY NET

alter table public.cron_manifest add column if not exists plain_label text;
alter table public.cron_manifest add column if not exists consequence text;

update public.cron_manifest set plain_label = v.lbl, consequence = v.con
from (values
  ('sync-meta-daily','Ad spend collection','ad spend and cost figures stop moving'),
  ('sync-ghl-leads-6h','Registration collection','new registrations stop appearing'),
  ('sync-zoom-4x','Webinar attendance collection','show-up figures stop moving'),
  ('capture-recordings-hourly','Webinar recording capture','recordings expire before they are saved'),
  ('sync-ledger-daily','Collections ledger import','sales and cash figures stop moving'),
  ('sync-team-register-daily','Team source register import','new source evidence stops arriving'),
  ('sync-tagmango-payments-daily','Course access payments import','course access figures go stale'),
  ('sync-tagmango-products-weekly','Course list refresh','new courses are not recognised'),
  ('sync-creative-daily','Ad creative collection','new ads have no text to read'),
  ('tag-scripts-daily','Ad script matching','new ads are not matched to a script'),
  ('refresh-source-precompute-daily','Source attribution rebuild','the Sources screen goes stale'),
  ('rebuild-baselines-daily','Expected-yield baselines','thin-run warnings lose their reference'),
  ('run-proof-daily','Nightly cross-checks','nothing is checked against a second source'),
  ('run-goldens-nightly','Signed-off figure re-checks','a changed figure is no longer noticed'),
  ('run-analyst-daily','Morning brief','the daily brief stops arriving'),
  ('verify-queue-daily','Review list tidy-up','the decision list fills with stale items'),
  ('creative-brief-fortnightly','Creative brief','no new creative brief is written'),
  ('creative-weekly-monday','Weekly creative summary','the weekly creative view goes stale'),
  ('discover-accounts-weekly','New ad account discovery','a new ad account goes unnoticed'),
  ('analyze-core-tables-weekly','Database housekeeping','screens slow down over time'),
  ('close-month-monthly','Month close','finished months are not locked'),
  ('safety-net-selftest-weekly','Alarm self-test','a broken alarm stays unnoticed')
) as v(job,lbl,con)
where cron_manifest.jobname = v.job;

update public.cron_manifest set plain_label = coalesce(plain_label, replace(jobname,'-',' ')),
                                consequence = coalesce(consequence, 'this part of the engine stops updating');

insert into public.cron_manifest (jobname, url_path, schedule, body, max_gap_hours, timeout_ms, active, note, plain_label, consequence)
values ('safety-net-selftest-weekly','/api/public/cron/self-test','35 7 * * 1','{}'::jsonb,192,300000,true,
        'Weekly: checks that the alarms themselves still work.','Alarm self-test','a broken alarm stays unnoticed')
on conflict (jobname) do update set url_path = excluded.url_path, schedule = excluded.schedule,
  max_gap_hours = excluded.max_gap_hours, active = true, note = excluded.note,
  plain_label = excluded.plain_label, consequence = excluded.consequence;

alter table public.feed_config add column if not exists max_data_lag_days numeric;
update public.feed_config set max_data_lag_days = 10 where feed = 'recordings' and max_data_lag_days is null;
update public.feed_config set max_data_lag_days = 14 where feed = 'tm_products' and max_data_lag_days is null;

create table if not exists public.credential_register (
  key text primary key,
  label text not null,
  expires_at date,
  what_breaks text not null,
  how_to_renew text,
  note text,
  updated_at timestamptz not null default now()
);
grant select on public.credential_register to authenticated;
grant all on public.credential_register to service_role;
alter table public.credential_register enable row level security;
drop policy if exists "credential register readable" on public.credential_register;
create policy "credential register readable" on public.credential_register for select to authenticated using (true);
drop policy if exists "credential register service" on public.credential_register;
create policy "credential register service" on public.credential_register for all to service_role using (true) with check (true);

insert into public.credential_register (key,label,expires_at,what_breaks,how_to_renew,note) values
  ('meta_access_token','Meta (Facebook) advertising connection', null,
   'Ad spend, ad names and registration counts stop arriving, so every cost and return figure freezes.',
   'Generate a new long-lived token in Meta Business and save it in the project secrets.', null),
  ('zoom_credentials','Zoom connection', null,
   'Webinar attendance and recordings stop arriving, so show-up figures freeze.',
   'Re-authorise the Zoom app and save the new credentials.','Server-to-server credentials: no fixed expiry, but they lapse if the app is deactivated.'),
  ('tagmango_token','TagMango connection', null,
   'Course access and payment records stop arriving; the ledger is unaffected.',
   'Ask TagMango for a fresh API token and save it in the project secrets.','No published expiry date.'),
  ('google_sheets_connection','Google Sheets connection (collections ledger and team register)', null,
   'The collections ledger and the team source register stop importing, so sales and cash stop moving.',
   'Reconnect Google Sheets from the project settings.','Access can be revoked by the sheet owner at any time.')
on conflict (key) do nothing;

update public.credential_register c
   set expires_at = nullif(btrim(s.value),'')::date, updated_at = now()
  from public.app_settings s
 where s.key = 'meta_token_expires_at' and c.key = 'meta_access_token';

create or replace function public.credential_alert_rows()
returns table(key text, label text, expires_at date, days_left integer, level text, sentence text)
language sql stable security definer set search_path to 'public' as $$
  select c.key, c.label, c.expires_at,
         case when c.expires_at is null then null else (c.expires_at - current_date)::int end,
         case when c.expires_at is null then 'none'
              when c.expires_at - current_date <= 14 then 'critical'
              when c.expires_at - current_date <= 45 then 'warning'
              else 'none' end,
         case when c.expires_at is null
              then c.label || ' has no expiry date recorded.'
              else c.label || ' expires in ' || (c.expires_at - current_date) || ' day' ||
                   case when c.expires_at - current_date = 1 then '' else 's' end ||
                   ' (' || to_char(c.expires_at,'DD Mon YYYY') || '). If it lapses, ' || c.what_breaks
         end
    from public.credential_register c
   order by c.expires_at nulls last, c.label;
$$;

create table if not exists public.sync_retry_log (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  step text not null,
  attempt integer not null,
  reason text,
  at timestamptz not null default now()
);
create index if not exists sync_retry_log_at_idx on public.sync_retry_log (at desc);
grant select on public.sync_retry_log to authenticated;
grant all on public.sync_retry_log to service_role;
alter table public.sync_retry_log enable row level security;
drop policy if exists "retry log readable" on public.sync_retry_log;
create policy "retry log readable" on public.sync_retry_log for select to authenticated using (true);
drop policy if exists "retry log service" on public.sync_retry_log;
create policy "retry log service" on public.sync_retry_log for all to service_role using (true) with check (true);

create or replace function public.retry_summary_rows(p_days integer default 7)
returns table(source text, step text, retries bigint, last_at timestamptz, last_reason text)
language sql stable security definer set search_path to 'public' as $$
  select r.source, r.step, count(*)::bigint,
         max(r.at),
         (array_agg(r.reason order by r.at desc))[1]
    from public.sync_retry_log r
   where r.at > now() - (p_days || ' days')::interval
   group by r.source, r.step
   order by count(*) desc;
$$;

create or replace function public.job_watch_rows()
returns table(jobname text, plain_label text, schedule text, cadence_hours numeric,
              last_start timestamptz, last_end timestamptz, hours_since_start numeric,
              status text, sentence text, consequence text)
language sql stable security definer set search_path to 'public' as $$
  with j as (
    select m.jobname, m.plain_label, m.schedule, m.max_gap_hours::numeric as cadence_hours,
           m.consequence,
           (select max(d.start_time) from cron.job j2
              join cron.job_run_details d on d.jobid = j2.jobid
             where j2.jobname = m.jobname) as last_start,
           (select max(d.end_time) from cron.job j2
              join cron.job_run_details d on d.jobid = j2.jobid
             where j2.jobname = m.jobname and d.status = 'succeeded') as last_end,
           exists (select 1 from cron.job j3 where j3.jobname = m.jobname) as scheduled
      from public.cron_manifest m
     where m.active and coalesce(m.max_gap_hours,0) > 0
  )
  select j.jobname, j.plain_label, j.schedule, j.cadence_hours, j.last_start, j.last_end,
         case when j.last_start is null then null
              else round(extract(epoch from (now() - j.last_start))/3600.0, 2) end,
         case when not j.scheduled then 'not_scheduled'
              when j.last_start is null then 'never_ran'
              when now() - j.last_start > (j.cadence_hours * 1.5 || ' hours')::interval then 'missed'
              else 'on_time' end,
         case when not j.scheduled
                then j.plain_label || ' is no longer scheduled to run at all, so ' || j.consequence || '.'
              when j.last_start is null
                then j.plain_label || ' has never run, so ' || j.consequence || '.'
              when now() - j.last_start > (j.cadence_hours * 1.5 || ' hours')::interval
                then j.plain_label || ' has not run since ' ||
                     to_char(j.last_start at time zone 'Asia/Kolkata','DD Mon, h:miam') ||
                     ' — it is due every ' ||
                     case when j.cadence_hours >= 24 then round(j.cadence_hours/24)::text || ' day' ||
                               case when round(j.cadence_hours/24) = 1 then '' else 's' end
                          else round(j.cadence_hours)::text || ' hours' end ||
                     '. Until it runs, ' || j.consequence || '.'
              else j.plain_label || ' last ran ' ||
                   to_char(j.last_start at time zone 'Asia/Kolkata','DD Mon, h:miam') || '.' end,
         j.consequence
    from j
   order by j.plain_label;
$$;

create or replace function public.feed_recency_rows()
returns table(feed text, label text, is_blocking boolean, coverage_edge date,
              lag_days numeric, allowed_lag_days numeric, stalled boolean, sentence text)
language sql stable security definer set search_path to 'public' as $$
  with cov as (
    select f.feed, f.label, f.is_blocking, f.cadence_hours,
           coalesce(f.max_data_lag_days, greatest(f.cadence_hours/24.0, 1) + 1) as allowed,
           case f.feed
             when 'meta_ads' then (select max(d.date) from daily_metrics d where d.level = 'account')
             when 'zoom' then (select max(z.business_date) from zoom_sessions z)
             when 'ledger' then (select max(l.business_date) from ledger_inflow l)
             when 'tm_payments' then (select max(p.business_date) from tm_payments p)
             when 'tm_products' then (select max(pr.last_synced_at)::date from products pr)
             when 'leads' then (select max(le.business_date) from leads le)
             when 'proof' then (select max(rc.checked_at)::date from reconciliations rc)
             when 'recordings' then (select max(coalesce(zr.recorded_at, zr.created_at))::date from zoom_recordings zr)
           end as edge
      from feed_config f
  )
  select c.feed, c.label, c.is_blocking, c.edge,
         case when c.edge is null then null else (current_date - c.edge)::numeric end,
         round(c.allowed, 1),
         (c.edge is null or (current_date - c.edge) > c.allowed),
         case when c.edge is null
                then c.label || ' holds no data at all.'
              when (current_date - c.edge) > c.allowed
                then c.label || ' is still running, but nothing newer than ' ||
                     to_char(c.edge,'DD Mon') || ' has arrived — that is ' ||
                     (current_date - c.edge) || ' day' || case when current_date - c.edge = 1 then '' else 's' end ||
                     ' of nothing new.'
              else c.label || ' has data up to ' || to_char(c.edge,'DD Mon') || '.' end
    from cov c
   order by c.is_blocking desc, c.label;
$$;

create or replace function public.safety_net_rows()
returns table(key text, kind text, level text, text text, consequence text)
language sql stable security definer set search_path to 'public' as $$
  select 'job-' || j.jobname, 'missed_run', 'red', j.sentence, j.consequence
    from public.job_watch_rows() j
   where j.status <> 'on_time'
  union all
  select 'recency-' || r.feed, 'stalled_feed',
         case when r.is_blocking then 'red' else 'amber' end,
         r.sentence,
         case when r.is_blocking then 'today''s money figures are not today''s'
              else 'this part of the picture is out of date' end
    from public.feed_recency_rows() r
   where r.stalled
  union all
  select 'cred-' || c.key, 'credential', c.level, c.sentence,
         'the connection lapses and its data stops arriving'
    from public.credential_alert_rows() c
   where c.level in ('warning','critical');
$$;

insert into public.proof_registry (check_id, family, label, plain, expected_noise, fp_budget_per_30d, ord)
values
 ('inv_missed_runs','invariant','Every scheduled job ran on time',
  'Each scheduled job is expected to start again within one and a half times its own interval. Anything that has not is named here.',
  'A job may be listed for a few minutes around its due time.', 1, 60),
 ('inv_data_recency','invariant','Every feed is still bringing new data',
  'A feed can run without fault and still bring nothing new. This compares the newest date in each feed against how often it should move.',
  'A feed with no webinar on a given day will sit still for a day or two.', 2, 61)
on conflict (check_id) do update set label = excluded.label, plain = excluded.plain;

create or replace function public.inv_missed_runs_rows()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_total int; v_bad int; v_names text;
begin
  select count(*)::int, count(*) filter (where status <> 'on_time')::int,
         coalesce(string_agg(sentence, ' · ') filter (where status <> 'on_time'), '')
    into v_total, v_bad, v_names
    from public.job_watch_rows();

  return jsonb_build_array(jsonb_build_object(
    'check_id','inv_missed_runs','checked_at', now(),'for_date', current_date,
    'primary_value', v_total, 'primary_source','Scheduled jobs registered with a cadence',
    'witness_value', v_total - v_bad, 'witness_source','Those that started within one and a half intervals',
    'divergence_pct', case when v_total = 0 then 0 else round(-100.0*v_bad/v_total,2) end,
    'verdict', case when v_bad = 0 then 'match' else 'diverged' end,
    'note', case when v_bad = 0
            then 'All ' || v_total || ' scheduled jobs started on time.'
            else v_names end));
end $$;

create or replace function public.inv_data_recency_rows()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_total int; v_bad int; v_names text;
begin
  select count(*)::int, count(*) filter (where stalled)::int,
         coalesce(string_agg(sentence, ' · ') filter (where stalled), '')
    into v_total, v_bad, v_names
    from public.feed_recency_rows();

  return jsonb_build_array(jsonb_build_object(
    'check_id','inv_data_recency','checked_at', now(),'for_date', current_date,
    'primary_value', v_total, 'primary_source','Feeds that should be bringing data',
    'witness_value', v_total - v_bad, 'witness_source','Those whose newest data is recent enough',
    'divergence_pct', case when v_total = 0 then 0 else round(-100.0*v_bad/v_total,2) end,
    'verdict', case when v_bad = 0 then 'match' else 'diverged' end,
    'note', case when v_bad = 0
            then 'All ' || v_total || ' feeds are bringing new data.'
            else v_names end));
end $$;

create or replace function public.safety_net_selftest()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_problems text[] := '{}'; v_jobs int; v_nocad int; v_feeds int; v_recency int;
        v_golden_at timestamptz; v_net int; v_cred int; v_out jsonb;
begin
  select count(*)::int into v_jobs from cron_manifest where active;
  select count(*)::int into v_nocad from cron_manifest
   where active and (coalesce(max_gap_hours,0) <= 0 or coalesce(btrim(plain_label),'') = '');
  if v_nocad > 0 then
    v_problems := v_problems || (v_nocad || ' scheduled job(s) have no interval or no plain name, so a missed run could not be noticed');
  end if;

  begin
    select count(*)::int into v_recency from public.feed_recency_rows();
    select count(*)::int into v_feeds from feed_config;
    if v_recency < v_feeds then
      v_problems := v_problems || ('only ' || v_recency || ' of ' || v_feeds || ' feeds could be checked for freshness');
    end if;
  exception when others then
    v_problems := v_problems || ('the freshness rule could not be evaluated at all: ' || sqlerrm);
  end;

  begin
    select count(*)::int into v_net from public.job_watch_rows();
    if v_net = 0 then v_problems := v_problems || 'no scheduled job could be evaluated for missed runs'; end if;
  exception when others then
    v_problems := v_problems || ('the missed-run rule could not be evaluated: ' || sqlerrm);
  end;

  select max(run_at) into v_golden_at from golden_runs;
  if v_golden_at is null or v_golden_at < now() - interval '36 hours' then
    v_problems := v_problems || 'the signed-off figure checks have not run in the last 36 hours';
  end if;

  select count(*)::int into v_cred from credential_register where coalesce(btrim(what_breaks),'') = '';
  if v_cred > 0 then
    v_problems := v_problems || (v_cred || ' credential(s) have no note saying what breaks if they lapse');
  end if;

  v_out := jsonb_build_object(
    'checked_at', now(),
    'ok', coalesce(array_length(v_problems,1),0) = 0,
    'jobs_registered', v_jobs,
    'feeds_evaluated', v_recency,
    'goldens_last_run', v_golden_at,
    'problems', to_jsonb(v_problems));

  insert into app_settings (key, value, description)
  values ('safety_net_selftest', v_out::text, 'Weekly result of testing the alarms themselves')
  on conflict (key) do update set value = excluded.value, description = excluded.description;

  if coalesce(array_length(v_problems,1),0) > 0 then
    insert into review_items (kind, ref_id, title, detail, evidence, status)
    values ('owner_action','safety-net-selftest',
            'Some of the warning checks could not be tested',
            array_to_string(v_problems, ' · '), v_out, 'open')
    on conflict (kind, coalesce(ref_id,'')) where status = 'open'
    do update set title = excluded.title, detail = excluded.detail, evidence = excluded.evidence, updated_at = now();
  else
    update review_items set status = 'closed', updated_at = now()
     where kind = 'owner_action' and ref_id = 'safety-net-selftest' and status = 'open';
  end if;

  return v_out;
end $$;

insert into public.golden_tests (golden_id, metric_id, contract_version, window_start, window_end,
                                 expected_value, tolerance_abs, verified_by, note)
values ('jobs_within_cadence_live','jobs_within_cadence',1, current_date - 1, current_date - 1, 0, 0,
        'owner instruction 2026-09-19','Every registered job has run within its cadence (evaluated live, window is nominal)')
on conflict (golden_id) do nothing;

CREATE OR REPLACE FUNCTION public.run_golden(p_golden_id text, p_trigger text DEFAULT 'manual'::text, p_deploy_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare g record; v numeric; v_pass boolean; v_delta numeric; v_err text; v_sales numeric;
begin
  select * into g from golden_tests where golden_id = p_golden_id;
  if not found then return jsonb_build_object('error','no such golden'); end if;

  begin
    set local statement_timeout = '90s';

    if g.metric_id = 'meta_spend' then
      select coalesce(sum(spend),0) into v from daily_metrics
       where level = 'account' and date between g.window_start and g.window_end;
    elsif g.metric_id = 'measured_registrations' then
      select coalesce(sum(m.leads),0) into v from daily_metrics m
        join ad_accounts a on a.account_id = m.account_id
       where m.level = 'account' and a.lead_tracking_status = 'working'
         and m.date between g.window_start and g.window_end;
    elsif g.metric_id = 'cost_per_registration' then
      select round(coalesce(sum(m.spend),0) / nullif(coalesce(sum(m.leads),0),0), 2) into v
        from daily_metrics m join ad_accounts a on a.account_id = m.account_id
       where m.level = 'account' and a.lead_tracking_status = 'working'
         and m.date between g.window_start and g.window_end;
    elsif g.metric_id = 'cost_per_sale' then
      v_sales := public.golden_paid_l1_sales(g.window_start, g.window_end);
      select round(coalesce(sum(spend),0) / nullif(v_sales,0), 2) into v
        from daily_metrics
       where level = 'account' and date between g.window_start and g.window_end;
    elsif g.metric_id = 'sales_per_1000_leads' then
      v_sales := public.golden_paid_l1_sales(g.window_start, g.window_end);
      select round(1000.0 * v_sales / nullif(coalesce(sum(m.leads),0),0), 4) into v
        from daily_metrics m join ad_accounts a on a.account_id = m.account_id
       where m.level = 'account' and a.lead_tracking_status = 'working'
         and m.date between g.window_start and g.window_end;
    elsif g.metric_id = 'ledger_l1_new_sales' then
      select count(*)::numeric into v from ledger_inflow
       where counts_as_sale and product_tier = 'L1_SILVER'
         and business_date between g.window_start and g.window_end;
    elsif g.metric_id = 'paid_l1_collected_gross' then
      select round(coalesce(sum(d.collected_paid_gross),0),2) into v
        from public.ledger_paid_daily(g.window_start, g.window_end) d;
    elsif g.metric_id = 'l1_collected_all_sources' then
      select round(coalesce(sum(amount_received),0),2) into v from ledger_inflow
       where product_tier = 'L1_SILVER' and business_date between g.window_start and g.window_end;
    elsif g.metric_id = 'all_tier_collected' then
      select round(coalesce(sum(amount_received),0),2) into v from ledger_inflow
       where business_date between g.window_start and g.window_end;
    elsif g.metric_id = 'retention_60' then
      select round(100.0 * coalesce(sum(z.at_60),0) / nullif(coalesce(sum(z.attendees),0),0), 2) into v
        from public.zoom_event_rows(g.window_start, g.window_end, false) z;
    elsif g.metric_id = 'cohort_return_d90' then
      v := public.cohort_golden_d90(g.window_start, g.window_end);
      if v is null then v_err := 'the 90-day window for this acquisition month has not closed yet'; end if;
    elsif g.metric_id = 'jobs_within_cadence' then
      select count(*)::numeric into v from public.job_watch_rows() where status <> 'on_time';
    elsif g.metric_id like 'agency\_%' then
      v := public.agency_golden_value(g.metric_id, g.window_start, g.window_end);
    else
      v_err := 'No computation is defined for ' || g.metric_id;
    end if;
  exception when others then v_err := sqlerrm;
  end;

  if v_err is null then
    v_delta := v - g.expected_value;
    v_pass := case when g.tolerance_abs is not null then abs(v_delta) <= g.tolerance_abs
                   else abs(v_delta) <= abs(g.expected_value) * g.tolerance_pct / 100.0 end;
  end if;

  insert into golden_runs (golden_id, trigger_kind, deploy_ref, computed_value, delta, pass, error)
  values (p_golden_id, p_trigger, p_deploy_ref, v, v_delta, v_pass, v_err);

  return jsonb_build_object('golden_id', p_golden_id, 'expected', g.expected_value,
    'computed', v, 'delta', v_delta, 'pass', v_pass, 'error', v_err);
end $function$;
