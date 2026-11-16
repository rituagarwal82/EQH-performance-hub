
ALTER TABLE public.cron_manifest ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.inv_cron_alive_rows()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
declare v_total int; v_alive int; v_dead text[]; v_pending text[]; v_bad int; v_note text;
begin
  select count(*)::int into v_total from cron_manifest where active;

  -- Jobs too young to have reached their first slot: not healthy, not dead.
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

  -- A fired schedule only means the call was sent. Check it was accepted too.
  select count(*)::int into v_bad from net._http_response
   where created > now() - interval '24 hours' and (status_code is null or status_code >= 300);

  v_alive := v_total - coalesce(array_length(v_dead,1),0) - coalesce(array_length(v_pending,1),0);

  v_note := case when coalesce(array_length(v_dead,1),0) = 0
                 then 'All ' || v_alive || ' due scheduled jobs have completed at least once recently.'
                 else 'These jobs are not completing: ' || array_to_string(v_dead, ' · ') end
         || case when coalesce(array_length(v_pending,1),0) > 0
                 then ' Not due yet: ' || array_to_string(v_pending, ' · ') || '.' else '' end
         || case when v_bad > 0
                 then ' ' || v_bad || ' scheduled web call(s) were rejected in the last 24h.' else '' end;

  return jsonb_build_array(jsonb_build_object(
    'check_id','inv_cron_alive',
    'checked_at', now(),
    'for_date', current_date,
    'primary_value', v_total,
    'primary_source','Active jobs in the manifest',
    'witness_value', v_alive,
    'witness_source','Jobs due and completed inside twice their own interval',
    'divergence_pct', case when v_total = 0 then 0 else round(100.0*(v_alive - v_total)/v_total, 2) end,
    'verdict', case when coalesce(array_length(v_dead,1),0) = 0 and v_bad = 0 then 'match' else 'diverged' end,
    'note', v_note
  ));
end $fn$;
