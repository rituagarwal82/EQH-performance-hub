-- B1: bounded, batched, resumable ad matching -------------------------------
create index if not exists leads_unmatched_business_date_idx
  on public.leads (business_date)
  where ad_entity_ref is null;

drop function if exists public.resolve_lead_ad_refs(boolean);

create or replace function public.resolve_lead_ad_refs(
  p_only_new boolean default false,
  p_days integer default 14,
  p_limit integer default 5000
)
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
  v_cut date := (current_date - greatest(coalesce(p_days, 14), 0));
begin
  -- The batch: only leads that are still unlinked, inside the window, capped.
  -- This is what keeps the job off the full ~240k-row table.
  create temp table _batch on commit drop as
    select l.lead_id, l.ad_id, public.norm_ad_name(l.utm_content) as uc
      from public.leads l
     where l.ad_entity_ref is null
       and l.business_date >= v_cut
     order by l.business_date desc
     limit greatest(coalesce(p_limit, 5000), 1);
  create index on _batch (lead_id);

  -- Full re-match mode also picks up rows already name-matched in the window,
  -- so a corrected ad list can be applied without touching all of history.
  if not p_only_new then
    update public.leads l
       set ad_entity_ref = null, ad_match_type = null, ad_matched_at = null
     where l.ad_id is null
       and l.ad_match_type in ('name_exact','name_fuzzy')
       and l.business_date >= v_cut;

    insert into _batch (lead_id, ad_id, uc)
    select l.lead_id, l.ad_id, public.norm_ad_name(l.utm_content)
      from public.leads l
     where l.ad_entity_ref is null
       and l.business_date >= v_cut
       and not exists (select 1 from _batch b where b.lead_id = l.lead_id)
     order by l.business_date desc
     limit greatest(coalesce(p_limit, 5000), 1);
  end if;

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
    from _batch b
   where b.lead_id = l.lead_id
     and l.ad_id is not null;

  -- 2. exact unique normalised name match
  update public.leads l
     set ad_entity_ref = u.entity_id, ad_match_type = 'name_exact', ad_matched_at = now()
    from _batch b
    join _uniq u on u.nm = b.uc and u.n = 1
   where b.lead_id = l.lead_id
     and l.ad_id is null
     and l.ad_entity_ref is null;

  select count(*) into v_amb
    from _batch b
    join public.leads l on l.lead_id = b.lead_id
    join _uniq u on u.nm = b.uc and u.n > 1
   where l.ad_id is null and l.ad_entity_ref is null;

  -- 3. unique high-confidence fuzzy match, over the batch's names only
  perform set_limit(0.85);

  create temp table _todo on commit drop as
    select distinct b.uc
      from _batch b
      join public.leads l on l.lead_id = b.lead_id
     where l.ad_entity_ref is null and b.uc is not null;

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
    from _batch b
    join _fuzzy f on f.uc = b.uc
   where b.lead_id = l.lead_id
     and l.ad_id is null
     and l.ad_entity_ref is null;

  -- Counts describe THIS batch, not the whole table: a bounded job must report
  -- bounded numbers or the reading is a lie.
  return query
  select
    count(*) filter (where l.ad_match_type = 'id')::bigint,
    count(*) filter (where l.ad_match_type = 'name_exact')::bigint,
    count(*) filter (where l.ad_match_type = 'name_fuzzy')::bigint,
    v_amb,
    count(*) filter (where l.ad_entity_ref is null)::bigint
  from _batch b join public.leads l on l.lead_id = b.lead_id;
end;
$$;

revoke all on function public.resolve_lead_ad_refs(boolean, integer, integer) from public;
revoke all on function public.resolve_lead_ad_refs(boolean, integer, integer) from anon;
revoke all on function public.resolve_lead_ad_refs(boolean, integer, integer) from authenticated;
grant execute on function public.resolve_lead_ad_refs(boolean, integer, integer) to service_role;

-- B2(b): raw failure detail for diagnosis. Never rendered in the owner UI.
alter table public.sync_runs add column if not exists error_detail text;
comment on column public.sync_runs.error_detail is
  'Raw technical failure text (truncated). Diagnostic only - never shown to the owner.';