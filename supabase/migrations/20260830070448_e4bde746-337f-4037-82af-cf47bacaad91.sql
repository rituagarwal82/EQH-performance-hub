
create or replace function public.entity_grain_counts(p_start date, p_end date)
returns table(level text, rows_n bigint, entities bigint, spend numeric)
language sql stable security definer set search_path = public as $$
  select m.level, count(*)::bigint, count(distinct m.entity_id)::bigint, coalesce(sum(m.spend),0)
  from daily_metrics m
  where m.date between p_start and p_end and m.level <> 'account'
  group by m.level
$$;

create or replace function public.placement_rollup(p_start date, p_end date)
returns table(
  placement text, rows_n bigint, spend numeric, impressions bigint,
  link_clicks bigint, leads bigint, days_covered bigint
)
language sql stable security definer set search_path = public as $$
  select
    coalesce(m.placement, '(not reported)') as placement,
    count(*)::bigint,
    coalesce(sum(m.spend),0),
    coalesce(sum(m.impressions),0)::bigint,
    coalesce(sum(m.link_clicks),0)::bigint,
    case when count(*) filter (where m.leads is not null) = 0 then null
         else sum(m.leads)::bigint end,
    count(distinct m.date)::bigint
  from daily_metrics m
  where m.date between p_start and p_end
  group by 1
  order by 3 desc
$$;

create or replace function public.ledger_sale_timing_monthly(p_start date, p_end date, p_tier text default 'L1_SILVER')
returns table(
  period text, bucket text, sales bigint, collected numeric, lag_known bigint
)
language sql stable security definer set search_path = public as $$
  with sess as (
    select distinct business_date as d
    from zoom_sessions
    where business_date is not null
      and coalesce(session_role,'unknown') <> 'test'
  ),
  s as (
    select l.business_date,
           l.amount_received,
           (select max(sess.d) from sess where sess.d <= l.business_date) as last_session
    from ledger_inflow l
    where l.is_new_sale
      and l.business_date between p_start and p_end
      and (p_tier is null or l.product_tier = p_tier)
  )
  select
    to_char(date_trunc('month', business_date), 'YYYY-MM') as period,
    case
      when last_session is null then 'no_session'
      when business_date - last_session = 0 then 'same_day'
      when business_date - last_session between 1 and 7 then 'd1_7'
      else 'd8_plus'
    end as bucket,
    count(*)::bigint,
    coalesce(sum(amount_received),0),
    count(*) filter (where last_session is not null)::bigint
  from s
  group by 1,2
  order by 1,2
$$;

revoke execute on function public.entity_grain_counts(date,date) from public, anon;
revoke execute on function public.placement_rollup(date,date) from public, anon;
revoke execute on function public.ledger_sale_timing_monthly(date,date,text) from public, anon;
