DROP FUNCTION IF EXISTS public.refresh_lead_tracking_status(integer);
CREATE FUNCTION public.refresh_lead_tracking_status(p_days integer DEFAULT 30)
RETURNS TABLE(out_account_id text, old_status text, new_status text, pct numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
begin
  return query
  with matched as (
    select e.account_id acc, count(*)::numeric n
      from leads l
      join ad_entities e on e.entity_id = l.ad_entity_ref
     where l.business_date >= current_date - p_days
       and l.is_registered
     group by 1
  ),
  meta as (
    select m.account_id acc,
           coalesce(sum(m.leads),0)::numeric meta_leads,
           coalesce(sum(m.spend),0)::numeric spend
      from daily_metrics m
     where m.level = 'account' and m.date >= current_date - p_days
     group by 1
  ),
  calc as (
    select a.account_id acc,
           a.lead_tracking_status as old_s,
           case
             when coalesce(meta.spend,0) = 0 then a.lead_tracking_status
             when coalesce(meta.meta_leads,0) = 0 then 'broken'
             when coalesce(matched.n,0) / meta.meta_leads >= 0.60 then 'working'
             when coalesce(matched.n,0) / meta.meta_leads < 0.20 then 'broken'
             else 'unknown'
           end as new_s,
           case when coalesce(meta.meta_leads,0) = 0 then null
                else round(100.0 * coalesce(matched.n,0) / meta.meta_leads, 1) end as p
      from ad_accounts a
      left join meta on meta.acc = a.account_id
      left join matched on matched.acc = a.account_id
  ),
  upd as (
    update ad_accounts a
       set lead_tracking_status = c.new_s
      from calc c
     where a.account_id = c.acc
       and a.lead_tracking_status is distinct from c.new_s
    returning a.account_id acc
  )
  select c.acc, c.old_s, c.new_s, c.p
    from calc c
   where c.acc in (select u.acc from upd u);
end
$$;

REVOKE ALL ON FUNCTION public.refresh_lead_tracking_status(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_lead_tracking_status(integer) TO service_role;