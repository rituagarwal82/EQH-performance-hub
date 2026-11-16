-- 1. creative_scripts -------------------------------------------------------
create table if not exists public.creative_scripts (
  id uuid primary key default gen_random_uuid(),
  script_code text not null unique,
  title text,
  script_text text not null,
  first_8s_hook text,
  source text not null default 'manual' check (source in ('doc_seed','manual','meta_body')),
  language text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select on public.creative_scripts to authenticated;
grant all on public.creative_scripts to service_role;
alter table public.creative_scripts enable row level security;
create policy "auth reads creative_scripts" on public.creative_scripts
  for select to authenticated using (true);
create policy "service role manages creative_scripts" on public.creative_scripts
  for all to service_role using (true) with check (true);

create trigger creative_scripts_updated_at
  before update on public.creative_scripts
  for each row execute function public.update_updated_at_column();

-- 2. ad_script_map -----------------------------------------------------------
create table if not exists public.ad_script_map (
  ad_entity_id text primary key references public.ad_entities(entity_id) on delete cascade,
  script_id uuid not null references public.creative_scripts(id) on delete cascade,
  mapped_by text not null check (mapped_by in ('auto_name_match','manual')),
  confidence numeric not null default 1,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ad_script_map_script_idx on public.ad_script_map (script_id);

grant select on public.ad_script_map to authenticated;
grant all on public.ad_script_map to service_role;
alter table public.ad_script_map enable row level security;
create policy "auth reads ad_script_map" on public.ad_script_map
  for select to authenticated using (true);
create policy "service role manages ad_script_map" on public.ad_script_map
  for all to service_role using (true) with check (true);

create trigger ad_script_map_updated_at
  before update on public.ad_script_map
  for each row execute function public.update_updated_at_column();

-- 3. creative text on ad_entities --------------------------------------------
alter table public.ad_entities
  add column if not exists creative_body text,
  add column if not exists creative_title text,
  add column if not exists thumbnail_url text,
  add column if not exists creative_object_type text,
  add column if not exists creative_fetch_status text,
  add column if not exists creative_fetch_error text,
  add column if not exists creative_fetched_at timestamptz;

-- 4. demo_metrics ------------------------------------------------------------
create table if not exists public.demo_metrics (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  account_id text not null references public.ad_accounts(account_id) on delete cascade,
  entity_id text not null,
  age_bucket text not null default '(unknown)',
  gender text not null default '(unknown)',
  spend numeric(14,2) not null default 0,
  impressions bigint not null default 0,
  link_clicks integer not null default 0,
  leads integer not null default 0,
  synced_at timestamptz not null default now()
);

create unique index if not exists demo_metrics_unique_key
  on public.demo_metrics (date, entity_id, age_bucket, gender);
create index if not exists demo_metrics_date_idx on public.demo_metrics (date);
create index if not exists demo_metrics_entity_idx on public.demo_metrics (entity_id);

grant select on public.demo_metrics to authenticated;
grant all on public.demo_metrics to service_role;
alter table public.demo_metrics enable row level security;
create policy "auth reads demo_metrics" on public.demo_metrics
  for select to authenticated using (true);
create policy "service role manages demo_metrics" on public.demo_metrics
  for all to service_role using (true) with check (true);

create or replace function public.upsert_demo_metrics(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  with incoming as (
    select
      (r->>'date')::date as date,
      r->>'account_id' as account_id,
      r->>'entity_id' as entity_id,
      coalesce(nullif(r->>'age_bucket',''), '(unknown)') as age_bucket,
      coalesce(nullif(r->>'gender',''), '(unknown)') as gender,
      coalesce((r->>'spend')::numeric, 0) as spend,
      coalesce((r->>'impressions')::bigint, 0) as impressions,
      coalesce((r->>'link_clicks')::int, 0) as link_clicks,
      coalesce((r->>'leads')::int, 0) as leads
    from jsonb_array_elements(p_rows) as r
  ), agg as (
    select date, account_id, entity_id, age_bucket, gender,
           sum(spend) spend, sum(impressions) impressions,
           sum(link_clicks) link_clicks, sum(leads) leads
    from incoming
    where entity_id is not null and entity_id <> ''
    group by 1,2,3,4,5
  ), upserted as (
    insert into public.demo_metrics
      (date, account_id, entity_id, age_bucket, gender, spend, impressions, link_clicks, leads, synced_at)
    select date, account_id, entity_id, age_bucket, gender, spend, impressions, link_clicks, leads, now()
    from agg
    on conflict (date, entity_id, age_bucket, gender) do update set
      spend = excluded.spend,
      impressions = excluded.impressions,
      link_clicks = excluded.link_clicks,
      leads = excluded.leads,
      synced_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;
  return v_count;
end;
$$;

-- 5. seed / upsert scripts ----------------------------------------------------
create or replace function public.upsert_creative_scripts(p_rows jsonb, p_source text default 'doc_seed')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  with upserted as (
    insert into public.creative_scripts (script_code, title, script_text, first_8s_hook, source, language)
    select
      btrim(r->>'script_code'),
      nullif(btrim(coalesce(r->>'title','')), ''),
      r->>'script_text',
      nullif(btrim(coalesce(r->>'first_8s_hook','')), ''),
      coalesce(nullif(r->>'source',''), p_source),
      coalesce(nullif(r->>'language',''), 'en')
    from jsonb_array_elements(p_rows) as r
    where nullif(btrim(coalesce(r->>'script_code','')), '') is not null
      and nullif(btrim(coalesce(r->>'script_text','')), '') is not null
    on conflict (script_code) do update set
      title = coalesce(excluded.title, public.creative_scripts.title),
      script_text = excluded.script_text,
      first_8s_hook = coalesce(excluded.first_8s_hook, public.creative_scripts.first_8s_hook),
      source = excluded.source,
      language = excluded.language,
      updated_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;
  return v_count;
end;
$$;

-- 6. Reporting ----------------------------------------------------------------
create or replace function public.creative_registry(p_start date, p_end date)
returns table (
  script_id uuid,
  script_code text,
  title text,
  ads_mapped bigint,
  spend numeric,
  impressions bigint,
  link_clicks bigint,
  meta_leads bigint,
  tracked_leads bigint,
  attendees bigint,
  attendees_60 bigint,
  low_conf_ads bigint
)
language sql
stable
security definer
set search_path = public
as $$
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
    join public.leads l on l.ad_id = m.ad_entity_id
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
$$;

create or replace function public.creative_ad_rows(p_start date, p_end date, p_script uuid default null)
returns table (
  entity_id text,
  ad_name text,
  script_code text,
  confidence numeric,
  mapped_by text,
  creative_title text,
  creative_body text,
  thumbnail_url text,
  spend numeric,
  impressions bigint,
  link_clicks bigint,
  meta_leads bigint,
  tracked_leads bigint
)
language sql
stable
security definer
set search_path = public
as $$
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
      where l.ad_id = e.entity_id and l.is_import = false
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
$$;

create or replace function public.creative_unmapped_ads(p_days integer default 30)
returns table (
  entity_id text,
  ad_name text,
  account_id text,
  creative_title text,
  creative_body text,
  thumbnail_url text,
  spend numeric,
  leads bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    e.entity_id, e.name, e.account_id, e.creative_title, e.creative_body, e.thumbnail_url,
    coalesce(sum(d.spend),0)::numeric,
    coalesce(sum(d.leads),0)::bigint
  from public.ad_entities e
  join public.daily_metrics d
    on d.entity_id = e.entity_id and d.level = 'ad'
   and d.date >= (current_date - p_days)
  where e.level = 'ad'
    and not exists (select 1 from public.ad_script_map k where k.ad_entity_id = e.entity_id)
  group by e.entity_id, e.name, e.account_id, e.creative_title, e.creative_body, e.thumbnail_url
  having coalesce(sum(d.spend),0) > 0
  order by coalesce(sum(d.spend),0) desc
$$;

create or replace function public.script_mapping_queue()
returns table (
  ad_entity_id text,
  ad_name text,
  script_id uuid,
  script_code text,
  title text,
  confidence numeric,
  spend_30d numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    k.ad_entity_id, e.name, s.id, s.script_code, s.title, k.confidence,
    coalesce((select sum(d.spend) from public.daily_metrics d
               where d.entity_id = k.ad_entity_id and d.level = 'ad'
                 and d.date >= current_date - 30), 0)::numeric
  from public.ad_script_map k
  join public.creative_scripts s on s.id = k.script_id
  left join public.ad_entities e on e.entity_id = k.ad_entity_id
  where k.mapped_by = 'auto_name_match' and k.confidence < 0.8
  order by 7 desc, k.confidence asc
$$;

create or replace function public.creative_text_coverage()
returns table (
  ads_total bigint,
  ads_active bigint,
  with_body bigint,
  with_title bigint,
  fetch_failed bigint,
  never_fetched bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*)::bigint,
    count(*) filter (where e.status = 'ACTIVE')::bigint,
    count(*) filter (where nullif(btrim(coalesce(e.creative_body,'')),'') is not null)::bigint,
    count(*) filter (where nullif(btrim(coalesce(e.creative_title,'')),'') is not null)::bigint,
    count(*) filter (where e.creative_fetch_status = 'error')::bigint,
    count(*) filter (where e.creative_fetch_status is null)::bigint
  from public.ad_entities e
  where e.level = 'ad'
$$;

revoke all on function public.upsert_demo_metrics(jsonb) from public;
revoke all on function public.upsert_creative_scripts(jsonb, text) from public;
revoke all on function public.creative_registry(date, date) from public;
revoke all on function public.creative_ad_rows(date, date, uuid) from public;
revoke all on function public.creative_unmapped_ads(integer) from public;
revoke all on function public.script_mapping_queue() from public;
revoke all on function public.creative_text_coverage() from public;
grant execute on function public.upsert_demo_metrics(jsonb) to service_role;
grant execute on function public.upsert_creative_scripts(jsonb, text) to service_role;
grant execute on function public.creative_registry(date, date) to service_role;
grant execute on function public.creative_ad_rows(date, date, uuid) to service_role;
grant execute on function public.creative_unmapped_ads(integer) to service_role;
grant execute on function public.script_mapping_queue() to service_role;
grant execute on function public.creative_text_coverage() to service_role;