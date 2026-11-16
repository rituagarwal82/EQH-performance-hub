insert into public.utm_source_map (raw, platform, is_paid, note) values
  ('meta','meta',true,'Old URL template — kept raw so the retrofit is visible'),
  ('facebook_pw','meta',true,'New URL template'),
  ('facebook_p','meta',true,'New URL template')
on conflict (raw) do update set platform = excluded.platform, is_paid = excluded.is_paid, note = excluded.note, updated_at = now();

create or replace function public.lead_template_trend(p_days integer default 14)
returns table (
  day date,
  old_leads bigint,
  old_with_ad_id bigint,
  new_leads bigint,
  new_with_ad_id bigint
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
    count(*) filter (where lower(l.utm_source) in ('facebook','facebook_pw','facebook_p')) as new_leads,
    count(*) filter (where lower(l.utm_source) in ('facebook','facebook_pw','facebook_p') and l.ad_id is not null) as new_with_ad_id
  from public.leads l
  where l.is_registered
    and coalesce(l.registered_at, l.captured_at) >= now() - make_interval(days => greatest(p_days, 1))
    and lower(coalesce(l.utm_source,'')) in ('meta','facebook','facebook_pw','facebook_p')
  group by 1
  order by 1
$$;

grant execute on function public.lead_template_trend(integer) to authenticated, service_role;