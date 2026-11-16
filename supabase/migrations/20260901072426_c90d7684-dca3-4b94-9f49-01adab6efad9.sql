create or replace function public.concept_ledger(p_start date, p_end date)
returns table (
  concept_id text,
  name text,
  persona text,
  pain text,
  promise text,
  state text,
  reference_cpl numeric,
  opened_at timestamptz,
  state_changed_at timestamptz,
  iterations bigint,
  ads_mapped bigint,
  spend numeric,
  matched_leads bigint,
  matured_leads bigint,
  attendees bigint,
  attendees_60 bigint,
  matured_sales bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with att_any as (
    select coalesce(nullif(lower(p.email), ''), p.participant_id) pk
    from public.zoom_participants p
    where p.is_valid
    group by 1
  ), att_60 as (
    select pk from (
      select coalesce(nullif(lower(p.email), ''), p.participant_id) pk,
             p.session_uuid,
             sum(greatest(coalesce(p.duration_sec,0),0)) secs
      from public.zoom_participants p
      where p.is_valid
      group by 1,2
    ) t where secs >= 3600 group by 1
  ),
  cs as (
    select c.concept_id, cs.script_id
    from public.concepts c
    left join public.concept_scripts cs on cs.concept_id = c.concept_id
  ), ads as (
    select cs.concept_id, k.ad_entity_id
    from cs
    join public.ad_script_map k on k.script_id = cs.script_id
  ), sp as (
    select a.concept_id,
           coalesce(sum(d.spend),0)::numeric spend,
           count(distinct a.ad_entity_id)::bigint ads_mapped
    from ads a
    left join public.daily_metrics d
      on d.entity_id = a.ad_entity_id and d.level = 'ad'
     and d.date >= p_start and d.date <= p_end
    group by 1
  ), ld as (
    select a.concept_id,
           count(*)::bigint matched_leads,
           count(*) filter (where l.business_date <= p_end - 14)::bigint matured_leads,
           count(*) filter (where exists (
             select 1 from att_any z where z.pk = l.email_key))::bigint attendees,
           count(*) filter (where exists (
             select 1 from att_60 z where z.pk = l.email_key))::bigint attendees_60,
           count(*) filter (
             where l.business_date <= p_end - 14
               and exists (
                 select 1 from public.ledger_inflow li
                  where li.email_key = l.email_key
                    and li.is_new_sale
                    and li.business_date >= l.business_date
                    and li.business_date <= p_end))::bigint matured_sales
    from ads a
    join public.leads l on l.ad_id = a.ad_entity_id
    where l.business_date >= p_start and l.business_date <= p_end
      and l.is_import = false
      and l.email_key is not null
    group by 1
  )
  select c.concept_id, c.name, c.persona, c.pain, c.promise, c.state,
         c.reference_cpl, c.opened_at, c.state_changed_at,
         (select count(*) from public.concept_scripts x where x.concept_id = c.concept_id)::bigint,
         coalesce(sp.ads_mapped, 0),
         coalesce(sp.spend, 0),
         coalesce(ld.matched_leads, 0),
         coalesce(ld.matured_leads, 0),
         coalesce(ld.attendees, 0),
         coalesce(ld.attendees_60, 0),
         coalesce(ld.matured_sales, 0)
  from public.concepts c
  left join sp on sp.concept_id = c.concept_id
  left join ld on ld.concept_id = c.concept_id
  order by coalesce(sp.spend, 0) desc, c.concept_id
$$;

create or replace function public.demo_persona_audit(p_start date, p_end date)
returns table (
  persona text,
  age_bucket text,
  spend numeric,
  impressions bigint,
  link_clicks bigint,
  leads bigint,
  attendees_60 bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with att_60 as (
    select pk from (
      select coalesce(nullif(lower(p.email), ''), p.participant_id) pk,
             p.session_uuid,
             sum(greatest(coalesce(p.duration_sec,0),0)) secs
      from public.zoom_participants p
      where p.is_valid
      group by 1,2
    ) t where secs >= 3600 group by 1
  ),
  tagged as (
    select k.ad_entity_id, t.persona
    from public.ad_script_map k
    join public.script_tags t on t.script_id = k.script_id
  ), demo as (
    select tg.persona, dm.age_bucket,
           sum(dm.spend)::numeric spend,
           sum(dm.impressions)::bigint impressions,
           sum(dm.link_clicks)::bigint link_clicks,
           sum(dm.leads)::bigint leads
    from public.demo_metrics dm
    join tagged tg on tg.ad_entity_id = dm.entity_id
    where dm.date >= p_start and dm.date <= p_end and dm.age_bucket <> '(unknown)'
    group by 1,2
  ), att as (
    select tg.persona,
           count(*) filter (where exists (
             select 1 from att_60 z where z.pk = l.email_key))::bigint a60
    from public.leads l
    join tagged tg on tg.ad_entity_id = l.ad_id
    where l.business_date >= p_start and l.business_date <= p_end and l.is_import = false
    group by 1
  )
  select d.persona, d.age_bucket, d.spend, d.impressions, d.link_clicks, d.leads,
         coalesce(a.a60, 0)
  from demo d left join att a on a.persona = d.persona
  order by d.persona, d.age_bucket
$$;

create or replace function public.scaling_inputs(p_date date)
returns table (
  window_label text,
  days integer,
  spend numeric,
  registrations bigint,
  cpl numeric,
  attendees_60 bigint,
  cost_per_60 numeric,
  active_adsets bigint,
  sales bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with att_60 as (
    select pk from (
      select coalesce(nullif(lower(p.email), ''), p.participant_id) pk,
             p.session_uuid,
             sum(greatest(coalesce(p.duration_sec,0),0)) secs
      from public.zoom_participants p
      where p.is_valid
      group by 1,2
    ) t where secs >= 3600 group by 1
  ),
  w as (
    select '7d'::text lbl, 7 d, (p_date - 6)::date s, p_date e
    union all select '28d', 28, (p_date - 27)::date, p_date
  ), spend as (
    select w.lbl,
           coalesce(sum(m.spend),0)::numeric spend,
           coalesce(sum(m.leads),0)::bigint meta_leads
    from w left join public.daily_metrics m
      on m.level = 'account' and m.date >= w.s and m.date <= w.e
    group by 1
  ), regs as (
    select w.lbl,
           count(l.*)::bigint registrations,
           count(l.*) filter (where exists (
             select 1 from att_60 z where z.pk = l.email_key))::bigint a60
    from w left join public.leads l
      on l.business_date >= w.s and l.business_date <= w.e
     and l.is_import = false and l.is_registered
    group by 1
  ), adsets as (
    select w.lbl, count(distinct m.entity_id)::bigint n
    from w left join public.daily_metrics m
      on m.level = 'adset' and m.date >= w.s and m.date <= w.e and m.spend > 0
    group by 1
  ), sales as (
    select w.lbl, count(li.*)::bigint n
    from w left join public.ledger_inflow li
      on li.business_date >= w.s and li.business_date <= w.e and li.is_new_sale
    group by 1
  )
  select w.lbl, w.d, sp.spend, r.registrations,
         case when r.registrations > 0 then sp.spend / r.registrations end,
         r.a60,
         case when r.a60 > 0 then sp.spend / r.a60 end,
         a.n, s.n
  from w
  join spend sp on sp.lbl = w.lbl
  join regs r on r.lbl = w.lbl
  join adsets a on a.lbl = w.lbl
  join sales s on s.lbl = w.lbl
$$;

revoke all on function public.concept_ledger(date, date) from public, anon, authenticated;
revoke all on function public.demo_persona_audit(date, date) from public, anon, authenticated;
revoke all on function public.scaling_inputs(date) from public, anon, authenticated;
grant execute on function public.concept_ledger(date, date) to service_role;
grant execute on function public.demo_persona_audit(date, date) to service_role;
grant execute on function public.scaling_inputs(date) to service_role;