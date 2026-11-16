create table if not exists public.utm_agency_map (
  suffix text primary key,
  agency_code text not null,
  label text,
  note text,
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on public.utm_agency_map to authenticated;
grant all on public.utm_agency_map to service_role;
alter table public.utm_agency_map enable row level security;
create policy "Authenticated can read utm_agency_map" on public.utm_agency_map for select to authenticated using (true);
create policy "Authenticated can edit utm_agency_map" on public.utm_agency_map for all to authenticated using (true) with check (true);
create policy "Service role manages utm_agency_map" on public.utm_agency_map for all to service_role using (true) with check (true);

insert into public.utm_agency_map (suffix, agency_code, label, note) values
  ('_PW', 'SD', 'Sabhi Digital', 'Sabhi Digital template'),
  ('_P',  'SD', 'Sabhi Digital', 'Sabhi Digital template'),
  ('_RJ', 'RJ', 'In-house (Rajdeep)', 'In-house team'),
  ('_PRM','PRM','Parami', 'Reserved for Parami')
on conflict (suffix) do nothing;

create or replace function public.agency_code_for(p_utm_source text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.agency_code
  from public.utm_agency_map m
  where p_utm_source is not null
    and lower(btrim(p_utm_source)) like '%' || lower(m.suffix)
  order by length(m.suffix) desc
  limit 1
$$;

grant execute on function public.agency_code_for(text) to authenticated, service_role;

update public.leads
set agency_code = public.agency_code_for(utm_source)
where agency_code is distinct from public.agency_code_for(utm_source);

create or replace function public.lead_agency_rollup(p_since date, p_until date)
returns table (
  agency_code text,
  leads bigint,
  registered_leads bigint,
  leads_with_email bigint,
  sales bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with l as (
    select coalesce(agency_code, 'UNASSIGNED') as code, email_key, is_registered
    from public.leads
    where business_date between p_since and p_until
  )
  select
    l.code,
    count(*)::bigint,
    count(*) filter (where l.is_registered)::bigint,
    count(*) filter (where l.email_key is not null)::bigint,
    count(distinct s.person_key)::bigint
  from l
  left join public.tm_sales s on s.person_key = l.email_key
  group by l.code
  order by count(*) desc
$$;

grant execute on function public.lead_agency_rollup(date, date) to authenticated, service_role;

create or replace function public.upsert_leads(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare n integer;
begin
  with src as (
    select
      r->>'lead_id' as lead_id,
      coalesce(r->>'source_system','ghl') as source_system,
      nullif(r->>'email_raw','') as email_raw,
      nullif(lower(btrim(r->>'email_key')),'') as email_key,
      nullif(r->>'phone','') as phone,
      nullif(r->>'name','') as name,
      nullif(r->>'captured_at','')::timestamptz as captured_at,
      nullif(r->>'registered_at','')::timestamptz as registered_at,
      case when lower(btrim(coalesce(r->>'utm_source',''))) = 'source'
           then null else nullif(r->>'utm_source','') end as utm_source,
      (coalesce((r->>'is_import')::boolean, false)
        or lower(btrim(coalesce(r->>'utm_source',''))) = 'source') as is_import,
      nullif(r->>'utm_medium','') as utm_medium,
      nullif(r->>'utm_campaign','') as utm_campaign,
      nullif(r->>'utm_content','') as utm_content,
      nullif(r->>'utm_term','') as utm_term,
      nullif(r->>'utm_placement','') as utm_placement,
      nullif(r->>'campaign_id','') as campaign_id,
      nullif(r->>'adset_id','') as adset_id,
      nullif(r->>'ad_id','') as ad_id,
      nullif(r->>'fbclid','') as fbclid,
      nullif(r->>'fbc','') as fbc,
      nullif(r->>'fbp','') as fbp,
      nullif(r->>'landing_page','') as landing_page,
      nullif(r->>'source_platform','') as source_platform,
      nullif(r->>'platform','') as platform,
      coalesce((r->>'is_registered')::boolean, false) as is_registered,
      coalesce(
        (select array_agg(t) from jsonb_array_elements_text(coalesce(r->'tags','[]'::jsonb)) t),
        '{}'::text[]
      ) as tags,
      nullif(r->>'webinar_date','') as webinar_date,
      nullif(r->>'webinar_time','') as webinar_time,
      nullif(r->>'webinar_tag','') as webinar_tag,
      r->'raw' as raw
    from jsonb_array_elements(p_rows) r
  ),
  norm as (
    select s.*,
      public.agency_code_for(s.utm_source) as agency_code,
      (s.is_registered
       and (not s.is_import
            or (s.webinar_date is not null
                and exists (select 1 from unnest(s.tags) t where lower(t) = 'registered')))
      ) as is_registered_eff
    from src s
  ),
  ins as (
    insert into public.leads as l (
      lead_id, source_system, email_raw, email_key, phone, name,
      captured_at, registered_at, business_date,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_placement,
      campaign_id, adset_id, ad_id, fbclid, fbc, fbp,
      landing_page, source_platform, platform, is_registered, is_import, tags,
      webinar_date, webinar_time, webinar_tag, agency_code, raw, synced_at
    )
    select
      s.lead_id, s.source_system, s.email_raw, s.email_key, s.phone, s.name,
      s.captured_at, s.registered_at,
      public.business_date(coalesce(s.registered_at, s.captured_at)),
      s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term, s.utm_placement,
      s.campaign_id, s.adset_id, s.ad_id, s.fbclid, s.fbc, s.fbp,
      s.landing_page, s.source_platform, s.platform, s.is_registered_eff, s.is_import, s.tags,
      s.webinar_date, s.webinar_time, s.webinar_tag, s.agency_code, s.raw, now()
    from norm s
    where s.lead_id is not null
    on conflict (lead_id) do update set
      source_system = excluded.source_system,
      email_raw = excluded.email_raw,
      email_key = excluded.email_key,
      phone = excluded.phone,
      name = excluded.name,
      captured_at = excluded.captured_at,
      registered_at = excluded.registered_at,
      business_date = excluded.business_date,
      utm_source = excluded.utm_source,
      utm_medium = excluded.utm_medium,
      utm_campaign = excluded.utm_campaign,
      utm_content = excluded.utm_content,
      utm_term = excluded.utm_term,
      utm_placement = excluded.utm_placement,
      campaign_id = excluded.campaign_id,
      adset_id = excluded.adset_id,
      ad_id = excluded.ad_id,
      fbclid = excluded.fbclid,
      fbc = excluded.fbc,
      fbp = excluded.fbp,
      landing_page = excluded.landing_page,
      source_platform = excluded.source_platform,
      platform = excluded.platform,
      is_registered = excluded.is_registered,
      is_import = excluded.is_import,
      tags = excluded.tags,
      webinar_date = excluded.webinar_date,
      webinar_time = excluded.webinar_time,
      webinar_tag = excluded.webinar_tag,
      agency_code = excluded.agency_code,
      raw = excluded.raw,
      synced_at = now()
    returning 1
  )
  select count(*)::int into n from ins;
  return n;
end
$function$;
