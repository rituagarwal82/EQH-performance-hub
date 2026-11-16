-- SQL-only scheduled jobs are declared with an empty url_path.
INSERT INTO public.cron_manifest (jobname, schedule, url_path, body, max_gap_hours, active, note)
VALUES
 ('analyze-core-tables-weekly', '30 19 * * 0', '', '{}'::jsonb, 192, true,
  'Database-only: refreshes table statistics so the big tables keep planning fast queries.'),
 ('close-month-monthly', '10 2 5 * *', '', '{}'::jsonb, 768, true,
  'Database-only: closes finished months once the accounts team has settled them.')
ON CONFLICT (jobname) DO UPDATE
  SET schedule = excluded.schedule, url_path = excluded.url_path,
      max_gap_hours = excluded.max_gap_hours, active = true,
      note = excluded.note, updated_at = now();

CREATE OR REPLACE FUNCTION public.inv_cron_manifest_rows()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Web jobs go out through cron_post(jobname), which looks the address up in
  -- this same manifest. Either spelling counts as calling the right address.
  select array_agg(j.jobname || ': deployed command does not call ' || m.url_path order by j.jobname)
    into v_url
    from cron.job j join cron_manifest m on m.jobname = j.jobname and m.active
   where coalesce(m.url_path,'') <> ''
     and position(m.url_path in j.command) = 0
     and position('cron_post(''' || j.jobname || '''' in j.command) = 0;

  select array_agg(j.jobname || ': command neither calls out over the network nor is declared database-only'
                   order by j.jobname)
    into v_tomb
    from cron.job j
    left join cron_manifest m on m.jobname = j.jobname and m.active
   where coalesce(m.url_path,'') <> ''
     and j.command !~ 'net\.http_post'
     and position('cron_post(' in j.command) = 0;

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
                 then v_expected || ' scheduled jobs match the manifest exactly.'
                 else array_to_string(v_problems, ' · ') end
  ));
end $function$;

CREATE OR REPLACE FUNCTION public.inv_level_history_rows()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_acc numeric; v_ad numeric; v_bad int; v_worst text; v_verdict text; v_note text;
begin
  with cover as (
    -- Only judge an account from the first day it has ad-level figures at all;
    -- earlier history was never collected at that level and is not a mismatch.
    select account_id, min(date) first_ad
      from daily_metrics where level = 'ad' group by 1
  ),
  per_day as (
    select m.date, m.account_id,
           coalesce(sum(m.spend) filter (where m.level = 'account'), 0) a,
           coalesce(sum(m.spend) filter (where m.level = 'ad'), 0) d
      from daily_metrics m
      join cover c on c.account_id = m.account_id and m.date >= c.first_ad
     where m.date < (now() at time zone 'Asia/Kolkata')::date
     group by 1,2
  ),
  bad as (
    select * from per_day
     where (a > 0 or d > 0)
       and abs(a - d) > greatest(50, 0.02 * greatest(a, d))
  ),
  agg as (
    select account_id, min(date) mn, max(date) mx, count(*) n, sum(d - a) gap
      from bad group by 1 order by abs(sum(d - a)) desc limit 5
  )
  select (select coalesce(sum(a),0) from per_day),
         (select coalesce(sum(d),0) from per_day),
         (select count(*)::int from bad),
         (select string_agg(account_id || ' ' || mn || '..' || mx || ' (' || n || ' day(s), gap '
                            || round(gap,0) || ')', ' · ') from agg)
    into v_acc, v_ad, v_bad, v_worst;

  v_verdict := case when v_bad = 0 then 'match' else 'diverged' end;
  v_note := case when v_bad = 0
    then 'Wherever we hold ad-level figures, they add up to the account total for that day, all the way back.'
    else v_bad || ' account-day(s) where the account total and its own ads disagree by more than 2%. Worst: '
         || coalesce(v_worst,'') end;

  return jsonb_build_array(jsonb_build_object(
    'check_id','inv_level_history',
    'checked_at', now(),
    'for_date', (now() at time zone 'Asia/Kolkata')::date,
    'primary_value', round(v_acc,2),
    'primary_source','Account-level spend, every day with ad-level cover',
    'witness_value', round(v_ad,2),
    'witness_source','The same days added up from individual ads',
    'divergence_pct', case when v_acc = 0 then 0 else round(100*(v_acc - v_ad)/v_acc, 2) end,
    'verdict', v_verdict,
    'note', v_note));
end
$$;

REVOKE ALL ON FUNCTION public.inv_level_history_rows() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_level_history_rows() TO service_role;