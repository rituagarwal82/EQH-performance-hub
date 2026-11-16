CREATE OR REPLACE FUNCTION public.golden_paid_l1_sales(p_start date, p_end date)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  with keys as materialized (
    select distinct email_key from ledger_inflow
     where product_tier = 'L1_SILVER' and counts_as_sale
       and business_date between p_start and p_end
       and email_key is not null and email_key <> ''
  ),
  paid as materialized (
    select distinct on (l.email_key) l.email_key,
      (((not l.is_import) or (l.webinar_date is not null and exists (
            select 1 from unnest(l.tags) t where lower(t) = 'registered')))
       and (coalesce(m.is_paid,false) or l.ad_id is not null or l.campaign_id is not null
            or lower(coalesce(l.utm_medium,'')) = any(array['cpc','paid','ppc','paid_social']))) as is_paid
      from leads l
      join keys k on k.email_key = l.email_key
      left join utm_source_map m on m.raw = lower(btrim(coalesce(l.utm_source,'')))
     order by l.email_key, l.captured_at
  )
  select count(*)::numeric
    from ledger_inflow li
    join paid p on p.email_key = li.email_key and p.is_paid
   where li.product_tier = 'L1_SILVER' and li.counts_as_sale
     and li.business_date between p_start and p_end;
$$;

REVOKE ALL ON FUNCTION public.golden_paid_l1_sales(date, date) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.golden_paid_l1_sales(date, date) TO service_role;

CREATE OR REPLACE FUNCTION public.run_golden(p_golden_id text, p_trigger text DEFAULT 'manual'::text, p_deploy_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare g record; v numeric; v_pass boolean; v_delta numeric; v_err text; v_sales numeric;
begin
  select * into g from golden_tests where golden_id = p_golden_id;
  if not found then return jsonb_build_object('error','no such golden'); end if;

  begin
    set local statement_timeout = '90s';

    if g.metric_id = 'meta_spend' then
      select coalesce(sum(spend),0) into v from daily_metrics
       where level = 'account' and date between g.window_start and g.window_end;
    elsif g.metric_id = 'measured_registrations' then
      select coalesce(sum(m.leads),0) into v from daily_metrics m
        join ad_accounts a on a.account_id = m.account_id
       where m.level = 'account' and a.lead_tracking_status = 'working'
         and m.date between g.window_start and g.window_end;
    elsif g.metric_id = 'cost_per_registration' then
      select round(coalesce(sum(m.spend),0) / nullif(coalesce(sum(m.leads),0),0), 2) into v
        from daily_metrics m join ad_accounts a on a.account_id = m.account_id
       where m.level = 'account' and a.lead_tracking_status = 'working'
         and m.date between g.window_start and g.window_end;
    elsif g.metric_id = 'cost_per_sale' then
      -- Contract v3: TOTAL Meta spend over paid-attributed L1 new sales, so
      -- this shares a denominator with front-end ROAS.
      v_sales := public.golden_paid_l1_sales(g.window_start, g.window_end);
      select round(coalesce(sum(spend),0) / nullif(v_sales,0), 2) into v
        from daily_metrics
       where level = 'account' and date between g.window_start and g.window_end;
    elsif g.metric_id = 'sales_per_1000_leads' then
      v_sales := public.golden_paid_l1_sales(g.window_start, g.window_end);
      select round(1000.0 * v_sales / nullif(coalesce(sum(m.leads),0),0), 4) into v
        from daily_metrics m join ad_accounts a on a.account_id = m.account_id
       where m.level = 'account' and a.lead_tracking_status = 'working'
         and m.date between g.window_start and g.window_end;
    elsif g.metric_id = 'ledger_l1_new_sales' then
      select count(*)::numeric into v from ledger_inflow
       where counts_as_sale and product_tier = 'L1_SILVER'
         and business_date between g.window_start and g.window_end;
    elsif g.metric_id = 'paid_l1_collected_gross' then
      with keys as materialized (
        select distinct email_key from ledger_inflow
         where product_tier = 'L1_SILVER' and revenue_recognized
           and business_date between g.window_start and g.window_end
           and email_key is not null and email_key <> ''
      ),
      paid as materialized (
        select distinct on (l.email_key) l.email_key,
          (((not l.is_import) or (l.webinar_date is not null and exists (
                select 1 from unnest(l.tags) t where lower(t) = 'registered')))
           and (coalesce(m.is_paid,false) or l.ad_id is not null or l.campaign_id is not null
                or lower(coalesce(l.utm_medium,'')) = any(array['cpc','paid','ppc','paid_social']))) as is_paid
          from leads l
          join keys k on k.email_key = l.email_key
          left join utm_source_map m on m.raw = lower(btrim(coalesce(l.utm_source,'')))
         order by l.email_key, l.captured_at
      )
      select round(coalesce(sum(li.amount_received),0),2) into v
        from ledger_inflow li
        join paid p on p.email_key = li.email_key and p.is_paid
       where li.product_tier = 'L1_SILVER' and li.revenue_recognized
         and li.business_date between g.window_start and g.window_end;
    elsif g.metric_id = 'l1_collected_all_sources' then
      select round(coalesce(sum(amount_received),0),2) into v from ledger_inflow
       where product_tier = 'L1_SILVER' and business_date between g.window_start and g.window_end;
    elsif g.metric_id = 'all_tier_collected' then
      select round(coalesce(sum(amount_received),0),2) into v from ledger_inflow
       where business_date between g.window_start and g.window_end;
    elsif g.metric_id = 'retention_60' then
      select round(100.0 * coalesce(sum(z.at_60),0) / nullif(coalesce(sum(z.attendees),0),0), 2) into v
        from public.zoom_event_rows(g.window_start, g.window_end, false) z;
    else
      v_err := 'No computation is defined for ' || g.metric_id;
    end if;
  exception when others then v_err := sqlerrm;
  end;

  if v_err is null then
    v_delta := v - g.expected_value;
    v_pass := case when g.tolerance_abs is not null then abs(v_delta) <= g.tolerance_abs
                   else abs(v_delta) <= abs(g.expected_value) * g.tolerance_pct / 100.0 end;
  end if;

  insert into golden_runs (golden_id, trigger_kind, deploy_ref, computed_value, delta, pass, error)
  values (p_golden_id, p_trigger, p_deploy_ref, v, v_delta, v_pass, v_err);

  return jsonb_build_object('golden_id', p_golden_id, 'expected', g.expected_value,
    'computed', v, 'delta', v_delta, 'pass', v_pass, 'error', v_err);
end $function$;