alter table public.leads
  add column if not exists registered_at timestamptz,
  add column if not exists utm_placement text,
  add column if not exists fbclid text,
  add column if not exists fbc text,
  add column if not exists fbp text,
  add column if not exists source_platform text,
  add column if not exists is_registered boolean not null default false,
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists webinar_date text,
  add column if not exists webinar_time text,
  add column if not exists webinar_tag text;

create index if not exists leads_email_key_idx on public.leads (email_key);
create index if not exists leads_business_date_idx on public.leads (business_date);
create index if not exists leads_captured_at_idx on public.leads (captured_at);

create or replace function public.upsert_leads(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
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
      nullif(r->>'utm_source','') as utm_source,
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
  ins as (
    insert into public.leads as l (
      lead_id, source_system, email_raw, email_key, phone, name,
      captured_at, registered_at, business_date,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_placement,
      campaign_id, adset_id, ad_id, fbclid, fbc, fbp,
      landing_page, source_platform, platform, is_registered, tags,
      webinar_date, webinar_time, webinar_tag, raw, synced_at
    )
    select
      s.lead_id, s.source_system, s.email_raw, s.email_key, s.phone, s.name,
      s.captured_at, s.registered_at,
      public.business_date(coalesce(s.registered_at, s.captured_at)),
      s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term, s.utm_placement,
      s.campaign_id, s.adset_id, s.ad_id, s.fbclid, s.fbc, s.fbp,
      s.landing_page, s.source_platform, s.platform, s.is_registered, s.tags,
      s.webinar_date, s.webinar_time, s.webinar_tag, s.raw, now()
    from src s
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
      tags = excluded.tags,
      webinar_date = excluded.webinar_date,
      webinar_time = excluded.webinar_time,
      webinar_tag = excluded.webinar_tag,
      raw = excluded.raw,
      synced_at = now()
    returning 1
  )
  select count(*)::int into n from ins;
  return n;
end $$;

revoke execute on function public.upsert_leads(jsonb) from public, anon;
grant execute on function public.upsert_leads(jsonb) to service_role;

create or replace function public.lead_tracking_coverage(p_days integer default 30)
returns table (
  leads_total bigint,
  registered bigint,
  with_email bigint,
  without_email bigint,
  with_ad_id bigint,
  ad_id_pct numeric,
  with_campaign bigint,
  campaign_pct numeric,
  first_capture date,
  last_capture date
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
    count(*) filter (where utm_campaign is not null)::bigint,
    case when count(*) = 0 then null
         else round(100.0 * count(*) filter (where utm_campaign is not null) / count(*), 1) end,
    min(business_date),
    max(business_date)
  from w;
$$;

grant execute on function public.lead_tracking_coverage(integer) to authenticated, service_role;

update public.feed_config set cadence_hours = 6 where feed = 'leads';