-- EQH Performance Engine — core schema.
-- Applied through the Lovable Cloud migration tool once the backend is enabled.
-- Kept general so registrations / webinar attendance / purchases can be added later.

create table if not exists public.ad_accounts (
  account_id text primary key,
  name text not null,
  currency text not null default 'INR',
  status text,
  is_active boolean not null default true,
  agency_code text
);

grant select on public.ad_accounts to authenticated;
grant all on public.ad_accounts to service_role;
alter table public.ad_accounts enable row level security;
create policy "service role manages ad_accounts" on public.ad_accounts
  for all to service_role using (true) with check (true);

create table if not exists public.ad_entities (
  entity_id text primary key,
  level text not null check (level in ('campaign','adset','ad')),
  account_id text not null references public.ad_accounts(account_id) on delete cascade,
  parent_id text,
  name text,
  status text,
  agency_code text
);

grant select on public.ad_entities to authenticated;
grant all on public.ad_entities to service_role;
alter table public.ad_entities enable row level security;
create policy "service role manages ad_entities" on public.ad_entities
  for all to service_role using (true) with check (true);

create index if not exists ad_entities_account_idx on public.ad_entities (account_id);

create table if not exists public.daily_metrics (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  account_id text not null references public.ad_accounts(account_id) on delete cascade,
  entity_id text,
  level text not null check (level in ('account','campaign','adset','ad')),
  placement text,
  spend numeric(14,2) not null default 0,
  impressions bigint not null default 0,
  link_clicks integer not null default 0,
  landing_page_views integer not null default 0,
  leads integer not null default 0,
  purchases integer not null default 0,
  synced_at timestamptz not null default now()
);

-- NULLs never conflict inside a plain UNIQUE constraint, so the upsert key is a
-- coalesced unique index instead.
create unique index if not exists daily_metrics_unique_key
  on public.daily_metrics (date, account_id, coalesce(entity_id, ''), level, coalesce(placement, ''));

create index if not exists daily_metrics_date_idx on public.daily_metrics (date);
create index if not exists daily_metrics_account_date_idx on public.daily_metrics (account_id, date);
create index if not exists daily_metrics_entity_date_idx on public.daily_metrics (entity_id, date);

grant select on public.daily_metrics to authenticated;
grant all on public.daily_metrics to service_role;
alter table public.daily_metrics enable row level security;
create policy "service role manages daily_metrics" on public.daily_metrics
  for all to service_role using (true) with check (true);

create table if not exists public.sync_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  source text,
  rows_written integer,
  status text,
  error text
);

grant select on public.sync_runs to authenticated;
grant all on public.sync_runs to service_role;
alter table public.sync_runs enable row level security;
create policy "service role manages sync_runs" on public.sync_runs
  for all to service_role using (true) with check (true);

create index if not exists sync_runs_started_idx on public.sync_runs (started_at desc);

-- Rollups --------------------------------------------------------------------

create or replace function public.account_month_rollup(p_start date, p_end date)
returns table (
  account_id text,
  name text,
  agency_code text,
  is_active boolean,
  spend numeric,
  leads bigint,
  has_data boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.account_id,
    a.name,
    a.agency_code,
    a.is_active,
    coalesce(sum(m.spend), 0)::numeric,
    coalesce(sum(m.leads), 0)::bigint,
    count(m.id) > 0
  from public.ad_accounts a
  left join public.daily_metrics m
    on m.account_id = a.account_id
   and m.level = 'account'
   and m.date >= p_start
   and m.date <= p_end
  group by a.account_id, a.name, a.agency_code, a.is_active
  order by coalesce(sum(m.spend), 0) desc, a.name asc
$$;

create or replace function public.monthly_spend(p_year integer)
returns table (month integer, spend numeric, leads bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    extract(month from m.date)::int,
    sum(m.spend)::numeric,
    sum(m.leads)::bigint
  from public.daily_metrics m
  where m.level = 'account'
    and extract(year from m.date) = p_year
  group by 1
  order by 1
$$;

revoke all on function public.account_month_rollup(date, date) from public;
revoke all on function public.monthly_spend(integer) from public;
grant execute on function public.account_month_rollup(date, date) to service_role;
grant execute on function public.monthly_spend(integer) to service_role;

-- Seed accounts ---------------------------------------------------------------

insert into public.ad_accounts (account_id, name, currency, status, is_active, agency_code) values
  ('1249430309131428', 'Ritu Agarwal 2', 'INR', 'active', true, null),
  ('1177480620566796', 'Ritu Agarwal-SX-2', 'INR', 'active', true, 'SX'),
  ('1091860385814643', 'Ritu Agarwal-SX', 'INR', 'active', true, 'SX'),
  ('2929556933907035', 'Ritu-SX3', 'INR', 'active', true, 'SX'),
  ('1488704194840585', 'Ritu Ad manager', 'INR', 'active', true, null),
  ('699110549552181', 'EQH_SD', 'INR', 'active', true, 'SD'),
  ('587640350334915', 'Ritu-Sabhi Digital-3', 'INR', 'active', true, 'SD'),
  ('514274773001361', 'Ritu Sabhi Digital', 'INR', 'active', true, 'SD'),
  ('1766718867459790', 'Ritu Agarwal-Sabhi Digital2', 'INR', 'active', true, 'SD'),
  ('171158705384198', 'Ritu Nikunj Ad Ac', 'INR', 'active', true, null),
  ('886948362374833', 'Ritu New 4', 'INR', 'active', true, null),
  ('742306694094489', 'Ritu IDLS', 'INR', 'active', true, null),
  ('1292097099554679', 'Ritu Agarwal (Read-Only)', 'INR', 'active', true, null),
  ('1475486154247855', 'Ritu Agarwal (Read-Only) 2', 'INR', 'active', true, null),
  ('517296235376502', 'Ritu Agarwal (disabled by Meta)', 'INR', 'disabled', false, null),
  ('326788779184576', 'Ritu Agarwal', 'INR', 'active', false, null)
on conflict (account_id) do update
  set name = excluded.name,
      status = excluded.status,
      is_active = excluded.is_active,
      agency_code = excluded.agency_code;

-- Bulk upsert used by the sync job (expression unique index needs raw SQL) -----

create or replace function public.upsert_daily_metrics(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with incoming as (
    select
      (r->>'date')::date as date,
      r->>'account_id' as account_id,
      nullif(r->>'entity_id', '') as entity_id,
      r->>'level' as level,
      nullif(r->>'placement', '') as placement,
      coalesce((r->>'spend')::numeric, 0) as spend,
      coalesce((r->>'impressions')::bigint, 0) as impressions,
      coalesce((r->>'link_clicks')::int, 0) as link_clicks,
      coalesce((r->>'landing_page_views')::int, 0) as landing_page_views,
      coalesce((r->>'leads')::int, 0) as leads,
      coalesce((r->>'purchases')::int, 0) as purchases
    from jsonb_array_elements(p_rows) as r
  ), upserted as (
    insert into public.daily_metrics
      (date, account_id, entity_id, level, placement, spend, impressions,
       link_clicks, landing_page_views, leads, purchases, synced_at)
    select date, account_id, entity_id, level, placement, spend, impressions,
           link_clicks, landing_page_views, leads, purchases, now()
    from incoming
    on conflict (date, account_id, coalesce(entity_id, ''), level, coalesce(placement, ''))
    do update set
      spend = excluded.spend,
      impressions = excluded.impressions,
      link_clicks = excluded.link_clicks,
      landing_page_views = excluded.landing_page_views,
      leads = excluded.leads,
      purchases = excluded.purchases,
      synced_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;
  return v_count;
end;
$$;

create or replace function public.upsert_ad_entities(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with upserted as (
    insert into public.ad_entities (entity_id, level, account_id, parent_id, name, status, agency_code)
    select
      r->>'entity_id', r->>'level', r->>'account_id',
      nullif(r->>'parent_id', ''), r->>'name', r->>'status', nullif(r->>'agency_code', '')
    from jsonb_array_elements(p_rows) as r
    on conflict (entity_id) do update set
      level = excluded.level,
      account_id = excluded.account_id,
      parent_id = excluded.parent_id,
      name = excluded.name,
      status = excluded.status,
      agency_code = excluded.agency_code
    returning 1
  )
  select count(*) into v_count from upserted;
  return v_count;
end;
$$;

revoke all on function public.upsert_daily_metrics(jsonb) from public;
revoke all on function public.upsert_ad_entities(jsonb) from public;
grant execute on function public.upsert_daily_metrics(jsonb) to service_role;
grant execute on function public.upsert_ad_entities(jsonb) to service_role;
