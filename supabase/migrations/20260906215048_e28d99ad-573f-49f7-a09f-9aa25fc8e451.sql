
CREATE OR REPLACE FUNCTION public.contract_drift()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
declare c record; fp text; drift int := 0; details text := '';
begin
  for c in select * from metric_contracts where is_current and source_function is not null loop
    select md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.oid)) into fp
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = c.source_function;

    if c.source_fingerprint is null then
      update metric_contracts set source_fingerprint = fp
       where metric_id = c.metric_id and version = c.version;
    elsif fp is distinct from c.source_fingerprint then
      drift := drift + 1;
      details := details || c.metric_id || ' (v' || c.version || ', ' || c.source_function || ') ';
      insert into review_items (kind, ref_id, title, detail, evidence, status)
      values ('contract_drift', c.metric_id,
              'The way ' || c.metric_id || ' is calculated changed without a new definition version',
              'Confirm the new calculation, then record a new contract version so comparison bands reset.',
              jsonb_build_object('metric_id', c.metric_id, 'version', c.version,
                                 'source_function', c.source_function), 'open')
      on conflict (kind, coalesce(ref_id, '')) where status = 'open'
      do update set title = excluded.title, detail = excluded.detail,
                    evidence = excluded.evidence, updated_at = now();
    end if;
  end loop;

  insert into reconciliations (check_id, for_date, primary_value, primary_source,
                               witness_value, witness_source, divergence_pct, verdict, note)
  values ('contract_drift', public.business_date(now()),
          (select count(*) from metric_contracts where is_current), 'metric contract',
          (select count(*) from metric_contracts where is_current) - drift, 'live calculation',
          case when drift = 0 then 0 else null end,
          case when drift = 0 then 'match' else 'diverged' end,
          case when drift = 0
               then 'Every contracted metric is still calculated the way its definition says'
               else 'The calculation changed while the definition stayed put: ' || details end)
  on conflict (check_id, for_date) do update
    set checked_at = now(), primary_value = excluded.primary_value,
        witness_value = excluded.witness_value, divergence_pct = excluded.divergence_pct,
        verdict = excluded.verdict, note = excluded.note;

  return jsonb_build_object('contracts', (select count(*) from metric_contracts where is_current),
                            'drifted', drift, 'detail', details);
end $fn$;

CREATE OR REPLACE FUNCTION public.run_golden(p_golden_id text, p_trigger text DEFAULT 'manual', p_deploy_ref text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
declare g record; v numeric; v_pass boolean; v_delta numeric; v_err text;
begin
  select * into g from golden_tests where golden_id = p_golden_id;
  if not found then return jsonb_build_object('error','no such golden'); end if;

  begin
    -- Load guard: one slow figure can never take the whole nightly run down.
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
    elsif g.metric_id = 'ledger_l1_new_sales' then
      select count(*)::numeric into v from ledger_inflow
       where counts_as_sale and product_tier = 'L1_SILVER'
         and business_date between g.window_start and g.window_end;
    elsif g.metric_id = 'paid_l1_collected_gross' then
      -- Same rule as lead_attribution.is_paid, evaluated only for the buyer
      -- keys in this window instead of the whole lead history.
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
end $fn$;
