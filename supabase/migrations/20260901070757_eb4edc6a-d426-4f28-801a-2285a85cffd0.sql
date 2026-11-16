-- 1. script_tags -------------------------------------------------------------
create table if not exists public.script_tags (
  script_id uuid primary key references public.creative_scripts(id) on delete cascade,
  persona text not null,
  persona_secondary text,
  pain text not null,
  hook_mechanism text not null,
  promise text not null,
  emotional_register text not null,
  spiritual_scale text not null,
  cta_style text not null,
  structure text not null,
  first_8s_hook text,
  tagged_by text not null default 'llm' check (tagged_by in ('llm','human')),
  confirmed boolean not null default false,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select on public.script_tags to authenticated;
grant all on public.script_tags to service_role;
alter table public.script_tags enable row level security;
create policy "auth reads script_tags" on public.script_tags
  for select to authenticated using (true);
create policy "service role manages script_tags" on public.script_tags
  for all to service_role using (true) with check (true);
create trigger script_tags_updated_at before update on public.script_tags
  for each row execute function public.update_updated_at_column();

-- 2. concept ledger -----------------------------------------------------------
create table if not exists public.concepts (
  concept_id text primary key,
  name text not null,
  persona text not null,
  pain text not null,
  promise text not null,
  state text not null default 'TESTING'
    check (state in ('TESTING','PROMISING','PROVEN','FATIGUED','RETIRED','KILLED')),
  reference_cpl numeric,
  note text,
  opened_at timestamptz not null default now(),
  state_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select on public.concepts to authenticated;
grant all on public.concepts to service_role;
alter table public.concepts enable row level security;
create policy "auth reads concepts" on public.concepts
  for select to authenticated using (true);
create policy "service role manages concepts" on public.concepts
  for all to service_role using (true) with check (true);
create trigger concepts_updated_at before update on public.concepts
  for each row execute function public.update_updated_at_column();

create table if not exists public.concept_scripts (
  concept_id text not null references public.concepts(concept_id) on delete cascade,
  script_id uuid not null references public.creative_scripts(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (concept_id, script_id)
);

grant select on public.concept_scripts to authenticated;
grant all on public.concept_scripts to service_role;
alter table public.concept_scripts enable row level security;
create policy "auth reads concept_scripts" on public.concept_scripts
  for select to authenticated using (true);
create policy "service role manages concept_scripts" on public.concept_scripts
  for all to service_role using (true) with check (true);

create table if not exists public.concept_state_log (
  id uuid primary key default gen_random_uuid(),
  concept_id text not null references public.concepts(concept_id) on delete cascade,
  from_state text,
  to_state text not null,
  reason text not null,
  evidence jsonb not null default '{}'::jsonb,
  decided_by text not null default 'human',
  created_at timestamptz not null default now()
);

create index if not exists concept_state_log_concept_idx
  on public.concept_state_log (concept_id, created_at desc);

grant select on public.concept_state_log to authenticated;
grant all on public.concept_state_log to service_role;
alter table public.concept_state_log enable row level security;
create policy "auth reads concept_state_log" on public.concept_state_log
  for select to authenticated using (true);
create policy "service role manages concept_state_log" on public.concept_state_log
  for all to service_role using (true) with check (true);

-- 3. review items --------------------------------------------------------------
create table if not exists public.review_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  ref_id text,
  title text not null,
  detail text,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','confirmed','rejected')),
  resolved_note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists review_items_open_key
  on public.review_items (kind, coalesce(ref_id, '')) where status = 'open';
create index if not exists review_items_status_idx on public.review_items (status, created_at desc);

grant select on public.review_items to authenticated;
grant all on public.review_items to service_role;
alter table public.review_items enable row level security;
create policy "auth reads review_items" on public.review_items
  for select to authenticated using (true);
create policy "service role manages review_items" on public.review_items
  for all to service_role using (true) with check (true);
create trigger review_items_updated_at before update on public.review_items
  for each row execute function public.update_updated_at_column();

-- 4. creative briefs -------------------------------------------------------------
create table if not exists public.creative_briefs (
  id uuid primary key default gen_random_uuid(),
  for_date date not null unique,
  brief_md text not null,
  evidence jsonb not null default '{}'::jsonb,
  model text,
  tokens integer,
  attempts integer not null default 1,
  approved boolean not null default false,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select on public.creative_briefs to authenticated;
grant all on public.creative_briefs to service_role;
alter table public.creative_briefs enable row level security;
create policy "auth reads creative_briefs" on public.creative_briefs
  for select to authenticated using (true);
create policy "service role manages creative_briefs" on public.creative_briefs
  for all to service_role using (true) with check (true);
create trigger creative_briefs_updated_at before update on public.creative_briefs
  for each row execute function public.update_updated_at_column();

-- An approved brief is a record, not a draft: it can be unapproved by a human
-- but its text and evidence can never be rewritten underneath the approval.
create or replace function public.creative_briefs_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.approved and (new.brief_md is distinct from old.brief_md
                       or new.evidence is distinct from old.evidence) then
    raise exception 'creative brief % is approved and immutable', old.for_date;
  end if;
  return new;
end;
$$;

drop trigger if exists creative_briefs_immutable_trg on public.creative_briefs;
create trigger creative_briefs_immutable_trg before update on public.creative_briefs
  for each row execute function public.creative_briefs_immutable();

-- 5. concept ledger reporting ------------------------------------------------------
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
  with cs as (
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
             select 1 from public.zoom_attendance z where z.person_key = l.email_key))::bigint attendees,
           count(*) filter (where exists (
             select 1 from public.zoom_attendance z
              where z.person_key = l.email_key and z.total_duration_sec >= 3600))::bigint attendees_60,
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

-- Persona-median baselines over a trailing window; '(account)' is the fallback
-- row used when a persona holds fewer than three concepts.
create or replace function public.persona_medians(p_days integer default 90)
returns table (
  persona text,
  n_concepts bigint,
  median_cpl numeric,
  median_cost_60 numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select l.persona, l.concept_id, l.spend, l.matched_leads, l.attendees_60
    from public.concept_ledger((current_date - p_days)::date, current_date) l
    where l.spend > 0 and l.matched_leads > 0
  ), per as (
    select persona,
           count(*)::bigint n,
           percentile_cont(0.5) within group (order by spend / nullif(matched_leads,0)) cpl,
           percentile_cont(0.5) within group (order by spend / nullif(attendees_60,0))
             filter (where attendees_60 > 0) c60
    from base group by 1
  )
  select persona, n, cpl, c60 from per
  union all
  select '(account)',
         (select count(*) from base)::bigint,
         (select percentile_cont(0.5) within group (order by spend / nullif(matched_leads,0)) from base),
         (select percentile_cont(0.5) within group (order by spend / nullif(attendees_60,0))
            from base where attendees_60 > 0)
$$;

-- Trailing-7d vs previous-7d fatigue statistics, per concept.
create or replace function public.concept_weekly_stats(p_end date)
returns table (
  concept_id text,
  state text,
  reference_cpl numeric,
  spend_7d numeric,
  leads_7d bigint,
  cpl_7d numeric,
  attendees_60_7d bigint,
  rate_60_7d numeric,
  spend_prev7 numeric,
  leads_prev7 bigint,
  cpl_prev7 numeric,
  rate_60_prev7 numeric,
  frequency_7d numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with cur as (select * from public.concept_ledger((p_end - 6)::date, p_end)),
       prv as (select * from public.concept_ledger((p_end - 13)::date, (p_end - 7)::date)),
       imp as (
         select cs.concept_id,
                coalesce(sum(d.impressions),0)::numeric impressions
         from public.concept_scripts cs
         join public.ad_script_map k on k.script_id = cs.script_id
         left join public.daily_metrics d on d.entity_id = k.ad_entity_id and d.level = 'ad'
          and d.date >= p_end - 6 and d.date <= p_end
         group by 1
       )
  select c.concept_id, c.state, c.reference_cpl,
         c.spend, c.matched_leads,
         case when c.matched_leads > 0 then c.spend / c.matched_leads end,
         c.attendees_60,
         case when c.attendees > 0 then c.attendees_60::numeric / c.attendees end,
         p.spend, p.matched_leads,
         case when p.matched_leads > 0 then p.spend / p.matched_leads end,
         case when p.attendees > 0 then p.attendees_60::numeric / p.attendees end,
         case when c.matched_leads > 0 then i.impressions / nullif(c.matched_leads,0) end
  from cur c
  left join prv p on p.concept_id = c.concept_id
  left join imp i on i.concept_id = c.concept_id
$$;

-- Share of live spend by persona / spiritual scale / hook mechanism.
create or replace function public.portfolio_balance(p_days integer default 30)
returns table (dimension text, label text, spend numeric, share numeric)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select t.persona, t.spiritual_scale, t.hook_mechanism,
           coalesce(sum(d.spend),0)::numeric spend
    from public.script_tags t
    join public.ad_script_map k on k.script_id = t.script_id
    left join public.daily_metrics d on d.entity_id = k.ad_entity_id and d.level = 'ad'
     and d.date >= current_date - p_days and d.date <= current_date
    group by 1,2,3
  ), tot as (select nullif(sum(spend),0) s from base)
  select 'persona', persona, sum(spend), sum(spend) / (select s from tot)
    from base group by 2
  union all
  select 'spiritual_scale', spiritual_scale, sum(spend), sum(spend) / (select s from tot)
    from base group by 2
  union all
  select 'hook_mechanism', hook_mechanism, sum(spend), sum(spend) / (select s from tot)
    from base group by 2
$$;

-- Persona-aggregate demographic audit. Never per ad, never per age-band cell
-- below persona level.
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
  with tagged as (
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
             select 1 from public.zoom_attendance z
              where z.person_key = l.email_key and z.total_duration_sec >= 3600))::bigint a60
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

-- Daily scaling inputs: 7d vs 28d efficiency, ad-set capacity, funnel rates.
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
  with w as (
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
             select 1 from public.zoom_attendance z
              where z.person_key = l.email_key and z.total_duration_sec >= 3600))::bigint a60
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

revoke all on function public.concept_ledger(date, date) from public;
revoke all on function public.persona_medians(integer) from public;
revoke all on function public.concept_weekly_stats(date) from public;
revoke all on function public.portfolio_balance(integer) from public;
revoke all on function public.demo_persona_audit(date, date) from public;
revoke all on function public.scaling_inputs(date) from public;
grant execute on function public.concept_ledger(date, date) to service_role;
grant execute on function public.persona_medians(integer) to service_role;
grant execute on function public.concept_weekly_stats(date) to service_role;
grant execute on function public.portfolio_balance(integer) to service_role;
grant execute on function public.demo_persona_audit(date, date) to service_role;
grant execute on function public.scaling_inputs(date) to service_role;