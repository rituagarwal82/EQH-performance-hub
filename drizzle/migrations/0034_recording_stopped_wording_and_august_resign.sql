update golden_tests
   set expected_value = 868648.26,
       note = 'Re-signed 20 Sep 2026: three August seat deposits of Rs 2,330 each (Pushpa 17 Aug, Raju Dattani 16 Aug, Gauri Sharma 19 Aug) were paid in full on 16 and 18 Sep, so their August cash became recognised revenue. No new August ledger row was typed in; the money was always in the sheet as a deposit.'
 where golden_id = 'paid_l1_collected_gross_2026_08';

create or replace function public.feed_recency_rows()
returns table (
  feed text, label text, is_blocking boolean, coverage_edge date,
  lag_days numeric, allowed_lag_days numeric, stalled boolean, sentence text
)
language sql
stable
security definer
set search_path = public
as $$
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
              when c.feed = 'recordings' and (current_date - c.edge) > c.allowed
                then 'No webinar recording has arrived since ' || to_char(c.edge,'DD Mon') ||
                     ', although ' ||
                     (select count(*) from zoom_sessions z where z.start_time::date > c.edge)::text ||
                     ' sessions have run. Someone must switch cloud recording back on in Zoom.'
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
returns table (key text, kind text, level text, text text, consequence text)
language sql
stable
security definer
set search_path = public
as $$
  select 'job-' || j.jobname, 'missed_run', 'red', j.sentence, j.consequence
    from public.job_watch_rows() j
   where j.status in ('missed','never_ran','not_scheduled')
  union all
  select 'recency-' || r.feed, 'stalled_feed',
         case when r.is_blocking then 'red' else 'amber' end,
         r.sentence,
         case when r.feed = 'recordings'
                then 'no webinar can be watched back, transcribed or used for script work'
              when r.is_blocking then 'today''s money figures are not today''s'
              else 'this part of the picture is out of date' end
    from public.feed_recency_rows() r
   where r.stalled
  union all
  select 'cred-' || c.key, 'credential', c.level, c.sentence,
         'the connection lapses and its data stops arriving'
    from public.credential_alert_rows() c
   where c.level in ('warning','critical');
$$;