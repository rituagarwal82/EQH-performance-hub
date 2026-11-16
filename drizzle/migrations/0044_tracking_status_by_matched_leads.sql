-- An account's lead tracking is judged on EVIDENCE OF MATCHED LEADS, never on
-- whether a lead row happens to store ad_account_id. Leads reach an account
-- either through the ad they matched (ad_entity_ref -> ad -> account) or
-- through a campaign name belonging to that account.

CREATE OR REPLACE FUNCTION public.account_tracking_evidence(p_days integer DEFAULT 30)
RETURNS TABLE(
  account_id text,
  name text,
  spend numeric,
  meta_leads numeric,
  matched_by_ad bigint,
  matched_by_campaign bigint,
  matched_total bigint,
  pct numeric,
  status_now text,
  status_by_evidence text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  with ads as (
    select e.account_id acc, count(*)::bigint n
      from leads l
      join ad_entities e on e.entity_id = l.ad_entity_ref
     where l.business_date >= current_date - p_days
       and l.is_registered
     group by 1
  ),
  camps as (
    select distinct e.account_id acc, lower(e.name) nm
      from ad_entities e
     where e.level = 'campaign' and e.name is not null
  ),
  byname as (
    select c.acc, count(*)::bigint n
      from leads l
      join camps c on lower(l.utm_campaign) = c.nm
     where l.business_date >= current_date - p_days
       and l.is_registered
       and l.ad_entity_ref is null
     group by 1
  ),
  meta as (
    select m.account_id acc,
           coalesce(sum(m.leads),0)::numeric meta_leads,
           coalesce(sum(m.spend),0)::numeric spend
      from daily_metrics m
     where m.level = 'account' and m.date >= current_date - p_days
     group by 1
  )
  select a.account_id,
         a.name,
         coalesce(meta.spend, 0),
         coalesce(meta.meta_leads, 0),
         coalesce(ads.n, 0),
         coalesce(byname.n, 0),
         (coalesce(ads.n, 0) + coalesce(byname.n, 0))::bigint,
         case when coalesce(meta.meta_leads, 0) = 0 then null
              else round(100.0 * (coalesce(ads.n,0) + coalesce(byname.n,0)) / meta.meta_leads, 1) end,
         a.lead_tracking_status,
         case
           when a.lead_tracking_status = 'not_applicable' then 'not_applicable'
           when coalesce(meta.spend, 0) = 0 then a.lead_tracking_status
           when coalesce(ads.n, 0) + coalesce(byname.n, 0) > 0 then 'working'
           else 'broken'
         end
    from ad_accounts a
    left join meta   on meta.acc   = a.account_id
    left join ads    on ads.acc    = a.account_id
    left join byname on byname.acc = a.account_id;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_lead_tracking_status(p_days integer DEFAULT 30)
RETURNS TABLE(out_account_id text, old_status text, new_status text, pct numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  return query
  with ev as (
    select * from public.account_tracking_evidence(p_days)
  ),
  upd as (
    update ad_accounts a
       set lead_tracking_status = e.status_by_evidence
      from ev e
     where a.account_id = e.account_id
       and a.lead_tracking_status is distinct from e.status_by_evidence
    returning a.account_id acc
  )
  select e.account_id, e.status_now, e.status_by_evidence, e.pct
    from ev e
   where e.account_id in (select u.acc from upd u);
end
$function$;

-- Re-evaluate every account now, on the corrected basis.
UPDATE public.ad_accounts a
   SET lead_tracking_status = e.status_by_evidence
  FROM public.account_tracking_evidence(30) e
 WHERE a.account_id = e.account_id
   AND a.lead_tracking_status IS DISTINCT FROM e.status_by_evidence;