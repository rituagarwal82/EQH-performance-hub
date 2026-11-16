create table if not exists public.script_link_proposals (
  ad_entity_id text primary key,
  script_id uuid not null references public.creative_scripts(id) on delete cascade,
  confidence numeric not null,
  basis text not null,
  status text not null default 'proposed',
  proposed_at timestamptz not null default now(),
  decided_at timestamptz
);

grant select, insert, update, delete on public.script_link_proposals to authenticated;
grant all on public.script_link_proposals to service_role;

alter table public.script_link_proposals enable row level security;

create policy "authenticated read script link proposals"
  on public.script_link_proposals for select to authenticated using (true);

create policy "service role manages script link proposals"
  on public.script_link_proposals for all to service_role using (true) with check (true);

create or replace function public.script_link_proposal_rows()
returns table(
  ad_entity_id text,
  ad_name text,
  account_id text,
  thumbnail_url text,
  permalink_url text,
  script_id uuid,
  script_code text,
  title text,
  confidence numeric,
  basis text,
  spend_30d numeric,
  leads_30d numeric
)
language sql stable security definer set search_path = public as $$
  select p.ad_entity_id,
         e.name,
         e.account_id,
         e.thumbnail_url,
         e.permalink_url,
         s.id,
         s.script_code,
         s.title,
         p.confidence,
         p.basis,
         coalesce(m.spend, 0),
         coalesce(m.leads, 0)
    from public.script_link_proposals p
    join public.creative_scripts s on s.id = p.script_id
    left join public.ad_entities e on e.entity_id = p.ad_entity_id
    left join lateral (
      select sum(d.spend) as spend, sum(d.leads) as leads
        from public.daily_metrics d
       where d.entity_id = p.ad_entity_id
         and d.date > current_date - 30
    ) m on true
   where p.status = 'proposed'
   order by coalesce(m.spend, 0) desc;
$$;

grant execute on function public.script_link_proposal_rows() to authenticated, service_role;

create or replace function public.creative_money_coverage(p_days int default 30)
returns table(ads_spent int, ads_mapped int, spend_total numeric, spend_mapped numeric)
language sql stable security definer set search_path = public as $$
  with s as (
    select d.entity_id, sum(d.spend) as spend
      from public.daily_metrics d
     where d.level = 'ad' and d.date > current_date - p_days
     group by 1
    having sum(d.spend) > 0
  )
  select count(*)::int,
         count(*) filter (where m.ad_entity_id is not null)::int,
         coalesce(sum(s.spend), 0),
         coalesce(sum(s.spend) filter (where m.ad_entity_id is not null), 0)
    from s
    left join public.ad_script_map m on m.ad_entity_id = s.entity_id;
$$;

grant execute on function public.creative_money_coverage(int) to authenticated, service_role;

create or replace function public.script_example_ads(p_days int default 30)
returns table(script_id uuid, entity_id text, account_id text, thumbnail_url text, permalink_url text)
language sql stable security definer set search_path = public as $$
  select distinct on (m.script_id)
         m.script_id, e.entity_id, e.account_id, e.thumbnail_url, e.permalink_url
    from public.ad_script_map m
    join public.ad_entities e on e.entity_id = m.ad_entity_id
    left join lateral (
      select sum(d.spend) as spend
        from public.daily_metrics d
       where d.entity_id = e.entity_id and d.date > current_date - p_days
    ) x on true
   order by m.script_id, coalesce(x.spend, 0) desc;
$$;

grant execute on function public.script_example_ads(int) to authenticated, service_role;