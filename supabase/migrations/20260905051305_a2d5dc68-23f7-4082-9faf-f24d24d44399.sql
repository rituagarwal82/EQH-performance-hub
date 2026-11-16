create extension if not exists pg_trgm with schema extensions;

alter table public.leads
  add column if not exists ad_entity_ref text,
  add column if not exists ad_match_type text,
  add column if not exists ad_matched_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_ad_match_type_check') then
    alter table public.leads add constraint leads_ad_match_type_check
      check (ad_match_type is null or ad_match_type in ('id','name_exact','name_fuzzy'));
  end if;
end $$;

create index if not exists leads_ad_entity_ref_idx on public.leads (ad_entity_ref);
create index if not exists leads_ad_match_type_idx on public.leads (ad_match_type);

create or replace function public.norm_ad_name(p text)
returns text
language sql
immutable
as $$ select nullif(lower(regexp_replace(btrim(coalesce(p,'')), '\s+', ' ', 'g')), '') $$;

create index if not exists ad_entities_norm_name_idx
  on public.ad_entities (public.norm_ad_name(name)) where level = 'ad';

-- Resolver -------------------------------------------------------------------
create or replace function public.resolve_lead_ad_refs(p_only_new boolean default false)
returns table (
  id_matched bigint,
  name_exact bigint,
  name_fuzzy bigint,
  ambiguous bigint,
  unmatched bigint
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_amb bigint := 0;
begin
  create temp table _names on commit drop as
    select e.entity_id, public.norm_ad_name(e.name) nm
    from public.ad_entities e
    where e.level = 'ad' and public.norm_ad_name(e.name) is not null;

  create temp table _uniq on commit drop as
    select nm, min(entity_id) entity_id, count(distinct entity_id) n
    from _names group by nm;
  create index on _uniq (nm);

  -- 1. ad id always wins
  update public.leads l
     set ad_entity_ref = l.ad_id, ad_match_type = 'id', ad_matched_at = now()
   where l.ad_id is not null
     and (l.ad_match_type is distinct from 'id' or l.ad_entity_ref is distinct from l.ad_id);

  -- clear stale name matches on rows we are about to reprocess
  update public.leads l
     set ad_entity_ref = null, ad_match_type = null, ad_matched_at = null
   where l.ad_id is null
     and l.ad_match_type in ('name_exact','name_fuzzy')
     and not p_only_new;

  -- 2. exact unique normalised name match
  update public.leads l
     set ad_entity_ref = u.entity_id, ad_match_type = 'name_exact', ad_matched_at = now()
    from _uniq u
   where l.ad_id is null
     and l.ad_entity_ref is null
     and u.n = 1
     and u.nm = public.norm_ad_name(l.utm_content);

  -- ambiguous: name exists but points at more than one ad
  select count(*) into v_amb
    from public.leads l join _uniq u on u.nm = public.norm_ad_name(l.utm_content)
   where l.ad_id is null and l.ad_entity_ref is null and u.n > 1;

  -- 3. unique high-confidence fuzzy match
  perform set_limit(0.85);

  create temp table _todo on commit drop as
    select distinct public.norm_ad_name(l.utm_content) uc
      from public.leads l
     where l.ad_id is null and l.ad_entity_ref is null
       and public.norm_ad_name(l.utm_content) is not null;

  create temp table _fuzzy on commit drop as
  with cand as (
    select t.uc, n.entity_id, similarity(n.nm, t.uc) s
      from _todo t
      join _names n on n.nm % t.uc
     where similarity(n.nm, t.uc) >= 0.85
  ), best as (
    select uc, max(s) ms from cand group by 1
  )
  select c.uc, min(c.entity_id) entity_id
    from cand c join best b on b.uc = c.uc and c.s = b.ms
   group by c.uc
  having count(distinct c.entity_id) = 1;
  create index on _fuzzy (uc);

  update public.leads l
     set ad_entity_ref = f.entity_id, ad_match_type = 'name_fuzzy', ad_matched_at = now()
    from _fuzzy f
   where l.ad_id is null and l.ad_entity_ref is null
     and f.uc = public.norm_ad_name(l.utm_content);

  return query
  select
    count(*) filter (where l.ad_match_type = 'id')::bigint,
    count(*) filter (where l.ad_match_type = 'name_exact')::bigint,
    count(*) filter (where l.ad_match_type = 'name_fuzzy')::bigint,
    v_amb,
    count(*) filter (where l.ad_entity_ref is null)::bigint
  from public.leads l;
end;
$$;

-- Leads whose ad-name text matches no current ad name -------------------------
create or replace function public.lead_name_match_orphans(p_days integer default 30)
returns table (orphan_leads bigint, orphan_names bigint, sample text[])
language sql
stable
security definer
set search_path = public, extensions
as $$
  with w as (
    select public.norm_ad_name(l.utm_content) uc, count(*) c
      from public.leads l
     where l.ad_id is null
       and l.ad_entity_ref is null
       and public.norm_ad_name(l.utm_content) is not null
       and (l.business_date is null or l.business_date >= current_date - greatest(p_days,1))
     group by 1
  ), o as (
    select w.* from w
     where not exists (
       select 1 from public.ad_entities e
        where e.level = 'ad' and public.norm_ad_name(e.name) = w.uc)
  )
  select coalesce(sum(c),0)::bigint,
         count(*)::bigint,
         (select array_agg(uc order by c desc) from (select uc, c from o order by c desc limit 10) s)
  from o;
$$;

-- Coverage: direct vs effective ----------------------------------------------
drop function if exists public.lead_tracking_coverage(integer);
create or replace function public.lead_tracking_coverage(p_days integer default 30)
returns table (
  leads_total bigint, registered bigint, with_email bigint, without_email bigint,
  with_ad_id bigint, ad_id_pct numeric,
  with_ad_ref bigint, ad_ref_pct numeric,
  name_exact bigint, name_fuzzy bigint,
  with_campaign bigint, campaign_pct numeric,
  first_capture date, last_capture date
)
language sql
stable
security definer
set search_path = public
as $$
  with w as (
    select * from public.leads
     where business_date is null
        or business_date >= current_date - p_days
  )
  select
    count(*)::bigint,
    count(*) filter (where is_registered)::bigint,
    count(*) filter (where email_key is not null)::bigint,
    count(*) filter (where email_key is null)::bigint,
    count(*) filter (where ad_id is not null)::bigint,
    case when count(*) = 0 then null
         else round(100.0 * count(*) filter (where ad_id is not null) / count(*), 1) end,
    count(*) filter (where ad_entity_ref is not null)::bigint,
    case when count(*) = 0 then null
         else round(100.0 * count(*) filter (where ad_entity_ref is not null) / count(*), 1) end,
    count(*) filter (where ad_match_type = 'name_exact')::bigint,
    count(*) filter (where ad_match_type = 'name_fuzzy')::bigint,
    count(*) filter (where utm_campaign is not null)::bigint,
    case when count(*) = 0 then null
         else round(100.0 * count(*) filter (where utm_campaign is not null) / count(*), 1) end,
    min(business_date),
    max(business_date)
  from w;
$$;

drop function if exists public.lead_template_trend(integer);
create or replace function public.lead_template_trend(p_days integer default 14)
returns table (
  day date, old_leads bigint, old_with_ad_id bigint, old_with_ref bigint,
  new_leads bigint, new_with_ad_id bigint, new_with_ref bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    public.business_date(coalesce(l.registered_at, l.captured_at)) as day,
    count(*) filter (where lower(l.utm_source) = 'meta') as old_leads,
    count(*) filter (where lower(l.utm_source) = 'meta' and l.ad_id is not null) as old_with_ad_id,
    count(*) filter (where lower(l.utm_source) = 'meta' and l.ad_entity_ref is not null) as old_with_ref,
    count(*) filter (where lower(l.utm_source) in ('facebook','facebook_pw','facebook_p')) as new_leads,
    count(*) filter (where lower(l.utm_source) in ('facebook','facebook_pw','facebook_p') and l.ad_id is not null) as new_with_ad_id,
    count(*) filter (where lower(l.utm_source) in ('facebook','facebook_pw','facebook_p') and l.ad_entity_ref is not null) as new_with_ref
  from public.leads l
  where l.is_registered
    and coalesce(l.registered_at, l.captured_at) >= now() - make_interval(days => greatest(p_days, 1))
    and lower(coalesce(l.utm_source,'')) in ('meta','facebook','facebook_pw','facebook_p')
  group by 1
  order by 1
$$;

-- Creative intelligence joins now use the resolved ad reference ---------------
create or replace function public.concept_ledger(p_start date, p_end date)
returns table (concept_id text, name text, persona text, pain text, promise text, state text, reference_cpl numeric, opened_at timestamptz, state_changed_at timestamptz, iterations bigint, ads_mapped bigint, spend numeric, matched_leads bigint, matured_leads bigint, attendees bigint, attendees_60 bigint, matured_sales bigint)
language sql
stable
security definer
set search_path = public
as $function$
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
    join public.leads l on l.ad_entity_ref = a.ad_entity_id
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
$function$;

create or replace function public.creative_ad_rows(p_start date, p_end date, p_script uuid default null)
returns table (entity_id text, ad_name text, script_code text, confidence numeric, mapped_by text, creative_title text, creative_body text, thumbnail_url text, spend numeric, impressions bigint, link_clicks bigint, meta_leads bigint, tracked_leads bigint)
language sql
stable
security definer
set search_path = public
as $function$
  select
    e.entity_id,
    e.name,
    s.script_code,
    k.confidence,
    k.mapped_by,
    e.creative_title,
    e.creative_body,
    e.thumbnail_url,
    coalesce(sum(d.spend),0)::numeric,
    coalesce(sum(d.impressions),0)::bigint,
    coalesce(sum(d.link_clicks),0)::bigint,
    coalesce(sum(d.leads),0)::bigint,
    (select count(*) from public.leads l
      where l.ad_entity_ref = e.entity_id and l.is_import = false
        and l.business_date >= p_start and l.business_date <= p_end)::bigint
  from public.ad_entities e
  left join public.ad_script_map k on k.ad_entity_id = e.entity_id
  left join public.creative_scripts s on s.id = k.script_id
  left join public.daily_metrics d
    on d.entity_id = e.entity_id and d.level = 'ad'
   and d.date >= p_start and d.date <= p_end
  where e.level = 'ad'
    and (p_script is null or k.script_id = p_script)
  group by e.entity_id, e.name, s.script_code, k.confidence, k.mapped_by,
           e.creative_title, e.creative_body, e.thumbnail_url
  having (p_script is not null or coalesce(sum(d.spend),0) > 0)
  order by coalesce(sum(d.spend),0) desc
$function$;

create or replace function public.creative_registry(p_start date, p_end date)
returns table (script_id uuid, script_code text, title text, ads_mapped bigint, spend numeric, impressions bigint, link_clicks bigint, meta_leads bigint, tracked_leads bigint, attendees bigint, attendees_60 bigint, low_conf_ads bigint)
language sql
stable
security definer
set search_path = public
as $function$
  with m as (
    select s.id as script_id, s.script_code, s.title, k.ad_entity_id, k.confidence
    from public.creative_scripts s
    left join public.ad_script_map k on k.script_id = s.id
  ), spend as (
    select m.script_id,
           coalesce(sum(d.spend),0)::numeric spend,
           coalesce(sum(d.impressions),0)::bigint impressions,
           coalesce(sum(d.link_clicks),0)::bigint link_clicks,
           coalesce(sum(d.leads),0)::bigint meta_leads
    from m
    left join public.daily_metrics d
      on d.entity_id = m.ad_entity_id and d.level = 'ad'
     and d.date >= p_start and d.date <= p_end
    group by 1
  ), lead_side as (
    select m.script_id,
           count(*)::bigint tracked_leads,
           count(*) filter (where exists (
             select 1 from public.zoom_attendance a where a.person_key = l.email_key
           ))::bigint attendees,
           count(*) filter (where exists (
             select 1 from public.zoom_attendance a
              where a.person_key = l.email_key and a.total_duration_sec >= 3600
           ))::bigint attendees_60
    from m
    join public.leads l on l.ad_entity_ref = m.ad_entity_id
    where l.business_date >= p_start and l.business_date <= p_end
      and l.is_import = false
    group by 1
  )
  select
    m.script_id,
    max(m.script_code),
    max(m.title),
    count(m.ad_entity_id)::bigint,
    coalesce(max(sp.spend),0),
    coalesce(max(sp.impressions),0),
    coalesce(max(sp.link_clicks),0),
    coalesce(max(sp.meta_leads),0),
    coalesce(max(ls.tracked_leads),0),
    coalesce(max(ls.attendees),0),
    coalesce(max(ls.attendees_60),0),
    count(*) filter (where m.ad_entity_id is not null and m.confidence < 0.8)::bigint
  from m
  left join spend sp on sp.script_id = m.script_id
  left join lead_side ls on ls.script_id = m.script_id
  group by m.script_id
  order by coalesce(max(sp.spend),0) desc, max(m.script_code)
$function$;

create or replace function public.demo_persona_audit(p_start date, p_end date)
returns table (persona text, age_bucket text, spend numeric, impressions bigint, link_clicks bigint, leads bigint, attendees_60 bigint)
language sql
stable
security definer
set search_path = public
as $function$
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
    join tagged tg on tg.ad_entity_id = l.ad_entity_ref
    where l.business_date >= p_start and l.business_date <= p_end and l.is_import = false
    group by 1
  )
  select d.persona, d.age_bucket, d.spend, d.impressions, d.link_clicks, d.leads,
         coalesce(a.a60, 0)
  from demo d left join att a on a.persona = d.persona
  order by d.persona, d.age_bucket
$function$;

revoke all on function public.resolve_lead_ad_refs(boolean) from public;
revoke all on function public.lead_name_match_orphans(integer) from public;
revoke all on function public.lead_tracking_coverage(integer) from public;
revoke all on function public.lead_template_trend(integer) from public;
revoke all on function public.concept_ledger(date, date) from public;
revoke all on function public.creative_ad_rows(date, date, uuid) from public;
revoke all on function public.creative_registry(date, date) from public;
revoke all on function public.demo_persona_audit(date, date) from public;
grant execute on function public.resolve_lead_ad_refs(boolean) to service_role;
grant execute on function public.lead_name_match_orphans(integer) to service_role;
grant execute on function public.lead_tracking_coverage(integer) to service_role;
grant execute on function public.lead_template_trend(integer) to service_role;
grant execute on function public.concept_ledger(date, date) to service_role;
grant execute on function public.creative_ad_rows(date, date, uuid) to service_role;
grant execute on function public.creative_registry(date, date) to service_role;
grant execute on function public.demo_persona_audit(date, date) to service_role;