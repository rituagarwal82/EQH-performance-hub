create or replace function public.job_watch_rows()
returns table(jobname text, plain_label text, schedule text, cadence_hours numeric,
              last_start timestamptz, last_end timestamptz, hours_since_start numeric,
              status text, sentence text, consequence text)
language sql stable security definer set search_path to 'public' as $$
  with j as (
    select m.jobname, m.plain_label, m.schedule, m.max_gap_hours::numeric as cadence_hours,
           m.consequence, m.first_seen_at,
           (select max(d.start_time) from cron.job j2
              join cron.job_run_details d on d.jobid = j2.jobid
             where j2.jobname = m.jobname) as last_start,
           (select max(d.end_time) from cron.job j2
              join cron.job_run_details d on d.jobid = j2.jobid
             where j2.jobname = m.jobname and d.status = 'succeeded') as last_end,
           exists (select 1 from cron.job j3 where j3.jobname = m.jobname) as scheduled
      from public.cron_manifest m
     where m.active and coalesce(m.max_gap_hours,0) > 0
  ),
  k as (
    select j.*,
           case when not j.scheduled then 'not_scheduled'
                -- A job registered less recently than one of its own intervals
                -- has genuinely never run; a newer one is simply not due yet.
                when j.last_start is null and j.first_seen_at > now() - (j.cadence_hours || ' hours')::interval
                  then 'not_due_yet'
                when j.last_start is null then 'never_ran'
                when now() - j.last_start > (j.cadence_hours * 1.5 || ' hours')::interval then 'missed'
                else 'on_time' end as st,
           case when j.cadence_hours >= 24
                then round(j.cadence_hours/24)::text || ' day' || case when round(j.cadence_hours/24) = 1 then '' else 's' end
                else round(j.cadence_hours)::text || ' hours' end as every
      from j
  )
  select k.jobname, k.plain_label, k.schedule, k.cadence_hours, k.last_start, k.last_end,
         case when k.last_start is null then null
              else round(extract(epoch from (now() - k.last_start))/3600.0, 2) end,
         k.st,
         case k.st
           when 'not_scheduled' then k.plain_label || ' is no longer scheduled to run at all, so ' || k.consequence || '.'
           when 'never_ran' then k.plain_label || ' has never run, so ' || k.consequence || '.'
           when 'not_due_yet' then k.plain_label || ' is newly registered and is not due yet.'
           when 'missed' then k.plain_label || ' has not run since ' ||
                to_char(k.last_start at time zone 'Asia/Kolkata','DD Mon, HH12:MIam') ||
                ' — it is due every ' || k.every || '. Until it runs, ' || k.consequence || '.'
           else k.plain_label || ' last ran ' ||
                to_char(k.last_start at time zone 'Asia/Kolkata','DD Mon, HH12:MIam') || '.' end,
         k.consequence
    from k
   order by k.plain_label;
$$;

create or replace function public.safety_net_rows()
returns table(key text, kind text, level text, text text, consequence text)
language sql stable security definer set search_path to 'public' as $$
  select 'job-' || j.jobname, 'missed_run', 'red', j.sentence, j.consequence
    from public.job_watch_rows() j
   where j.status in ('missed','never_ran','not_scheduled')
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

create or replace function public.inv_missed_runs_rows()
returns jsonb language plpgsql stable security definer set search_path to 'public' as $$
declare v_total int; v_bad int; v_names text;
begin
  select count(*)::int,
         count(*) filter (where status in ('missed','never_ran','not_scheduled'))::int,
         coalesce(string_agg(sentence, ' · ') filter (where status in ('missed','never_ran','not_scheduled')), '')
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
      select count(*)::numeric into v from public.job_watch_rows()
       where status in ('missed','never_ran','not_scheduled');
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
