create or replace function public.lead_page_rollup(p_start date default null, p_end date default null)
returns table (
  page_key text,
  key_kind text,
  leads bigint,
  registered bigint,
  first_date date,
  last_date date
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(
      nullif(btrim(l.landing_page), ''),
      nullif(btrim(l.utm_campaign), ''),
      '(nothing recorded)'
    ) as page_key,
    case
      when nullif(btrim(l.landing_page), '') is not null then 'landing_page'
      when nullif(btrim(l.utm_campaign), '') is not null then 'utm_campaign'
      else 'none'
    end as key_kind,
    count(*)::bigint,
    count(*) filter (where l.is_registered)::bigint,
    min(l.business_date),
    max(l.business_date)
  from public.leads l
  where (p_start is null or l.business_date >= p_start)
    and (p_end is null or l.business_date <= p_end)
  group by 1, 2
  order by 3 desc;
$$;

grant execute on function public.lead_page_rollup(date, date) to authenticated, service_role;