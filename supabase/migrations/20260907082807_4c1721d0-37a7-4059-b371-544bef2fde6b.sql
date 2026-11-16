-- 1. Derive lead tracking status from evidence, nightly.
CREATE OR REPLACE FUNCTION public.refresh_lead_tracking_status(p_days integer DEFAULT 30)
RETURNS TABLE(account_id text, old_status text, new_status text, pct numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
begin
  return query
  with matched as (
    select e.account_id, count(*)::numeric n
      from leads l
      join ad_entities e on e.entity_id = l.ad_entity_ref
     where l.business_date >= current_date - p_days
       and l.is_registered
     group by 1
  ),
  meta as (
    select m.account_id,
           coalesce(sum(m.leads),0)::numeric meta_leads,
           coalesce(sum(m.spend),0)::numeric spend
      from daily_metrics m
     where m.level = 'account' and m.date >= current_date - p_days
     group by 1
  ),
  calc as (
    select a.account_id,
           a.lead_tracking_status as old_status,
           case
             when coalesce(meta.spend,0) = 0 then a.lead_tracking_status
             when coalesce(meta.meta_leads,0) = 0 then 'broken'
             when coalesce(matched.n,0) / meta.meta_leads >= 0.60 then 'working'
             when coalesce(matched.n,0) / meta.meta_leads < 0.20 then 'broken'
             else 'unknown'
           end as new_status,
           case when coalesce(meta.meta_leads,0) = 0 then null
                else round(100.0 * coalesce(matched.n,0) / meta.meta_leads, 1) end as pct
      from ad_accounts a
      left join meta on meta.account_id = a.account_id
      left join matched on matched.account_id = a.account_id
  ),
  upd as (
    update ad_accounts a
       set lead_tracking_status = c.new_status
      from calc c
     where a.account_id = c.account_id
       and a.lead_tracking_status is distinct from c.new_status
    returning a.account_id
  )
  select c.account_id, c.old_status, c.new_status, c.pct
    from calc c
   where c.account_id in (select account_id from upd);
end
$$;

REVOKE ALL ON FUNCTION public.refresh_lead_tracking_status(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_lead_tracking_status(integer) TO service_role;

-- 2. Full-history reconciliation: account-level spend vs the sum of its ad rows.
CREATE OR REPLACE FUNCTION public.inv_level_history_rows()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_acc numeric; v_ad numeric; v_bad int; v_worst jsonb; v_verdict text; v_note text;
begin
  with per_day as (
    select m.date, m.account_id,
           coalesce(sum(m.spend) filter (where m.level = 'account'), 0) a,
           coalesce(sum(m.spend) filter (where m.level = 'ad'), 0) d
      from daily_metrics m
     where m.date < (now() at time zone 'Asia/Kolkata')::date
     group by 1,2
  ),
  bad as (
    select * from per_day
     where (a > 0 or d > 0)
       and abs(a - d) > greatest(50, 0.02 * greatest(a, d))
  )
  select coalesce(sum(a),0), coalesce(sum(d),0), count(*)::int,
         coalesce(jsonb_agg(jsonb_build_object('account', account_id, 'from', mn, 'to', mx, 'gap', round(gap,2))
                            order by gap desc), '[]'::jsonb)
    into v_acc, v_ad, v_bad, v_worst
    from (select b.a, b.d, b.account_id,
                 min(b.date) over (partition by b.account_id) mn,
                 max(b.date) over (partition by b.account_id) mx,
                 sum(b.d - b.a) over (partition by b.account_id) gap
            from bad b) t;

  select coalesce(jsonb_agg(distinct e), '[]'::jsonb) into v_worst
    from jsonb_array_elements(v_worst) e;

  v_verdict := case when v_bad = 0 then 'match' else 'diverged' end;
  v_note := case when v_bad = 0
    then 'Across the whole history, every account''s reported spend matches the spend added up from its own ads.'
    else v_bad || ' account-day(s) where the account total and its ads disagree by more than 2%. '
         || 'Worst: ' || coalesce(v_worst::text, '') end;

  return jsonb_build_array(jsonb_build_object(
    'check_id','inv_level_history',
    'checked_at', now(),
    'for_date', (now() at time zone 'Asia/Kolkata')::date,
    'primary_value', round(v_acc,2),
    'primary_source','Account-level spend, whole history',
    'witness_value', round(v_ad,2),
    'witness_source','The same days added up from individual ads',
    'divergence_pct', case when v_acc = 0 then 0 else round(100*(v_acc - v_ad)/v_acc, 2) end,
    'verdict', v_verdict,
    'note', v_note));
end
$$;

REVOKE ALL ON FUNCTION public.inv_level_history_rows() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_level_history_rows() TO service_role;

INSERT INTO public.proof_registry (check_id, family, label, plain, expected_noise, fp_budget_per_30d, structural_note, enabled, ord)
VALUES ('inv_level_history', 'invariant',
        'Spend adds up at every level, all year',
        'Compares each ad account''s own reported spend with the spend added up from its individual ads, for every day we hold — not just the last fortnight.',
        'None expected. A gap means a sync missed a stretch of days at one level.',
        0.5,
        'Days still accruing are excluded; tolerance is the greater of ₹50 or 2%.',
        true,
        (select coalesce(max(ord),0) + 1 from public.proof_registry))
ON CONFLICT (check_id) DO UPDATE SET enabled = true, updated_at = now();

-- 3. cost_per_sale: same spend denominator as ROAS.
UPDATE public.metric_contracts SET is_current = false
 WHERE metric_id = 'cost_per_sale' AND is_current;

INSERT INTO public.metric_contracts (metric_id, version, owner_definition, unit, basis, grain, source_function, is_current, note)
VALUES ('cost_per_sale', 3,
 'Total Meta account-level spend for the window divided by paid-attributed L1 new sales from the accounts ledger, with the Book My Seat rule applied (a seat becomes a sale only at full payment). Uses total spend, not measured-account spend, so it shares a denominator with front-end ROAS.',
 'inr', 'ex_gst', 'window', 'metric_components', true,
 'v2 divided by measured-account spend only, which made cost per sale look cheaper than ROAS implied on the same screen.');

UPDATE public.golden_tests
   SET expected_value = 11177.19,
       note = 'Recomputed on the v3 contract: total August Meta spend 15,98,337.43 over 143 paid-attributed L1 sales. v2 value 6,898.81 used measured-account spend only.'
 WHERE golden_id = 'cost_per_sale_aug2026';