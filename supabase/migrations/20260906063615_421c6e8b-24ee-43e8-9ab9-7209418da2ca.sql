-- ── 5. break-even inputs on one basis ────────────────────────────────────────
DROP FUNCTION IF EXISTS public.measured_ascension();
CREATE FUNCTION public.measured_ascension()
 RETURNS TABLE(l1_buyers bigint, ascended_buyers bigint, ascension_pct numeric,
               l3_avg_ticket numeric, l1_avg_ticket numeric,
               cohort_start date, cohort_end date,
               buyers_per_1000 numeric, buyers_window_start date, buyers_window_end date)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with l1 as (
    select distinct email_key from ledger_inflow
     where product_tier = 'L1_SILVER' and email_key is not null
  ),
  l3 as (
    select distinct email_key from ledger_inflow
     where product_tier in ('L3_DIAMOND','L4') and email_key is not null
  ),
  tickets as (
    -- ex-GST: ledger amounts are collected gross, ad spend is not
    select
      (select round(sum(amount_received) / 1.18 / nullif(count(*) filter (where is_new_sale), 0), 2)
         from ledger_inflow where product_tier = 'L3_DIAMOND') as l3_avg,
      (select round(sum(amount_received) / 1.18 / nullif(count(*) filter (where is_new_sale), 0), 2)
         from ledger_inflow where product_tier = 'L1_SILVER') as l1_avg
  ),
  cohort as (
    select min(business_date) s, max(business_date) e from ledger_inflow where email_key is not null
  ),
  bw as (
    select (public.business_date(now()) - 30)::date s, (public.business_date(now()) - 1)::date e
  ),
  buyers as (
    select
      (select count(*) from ledger_inflow li
        where li.product_tier = 'L1_SILVER' and li.is_new_sale
          and li.business_date between (select s from bw) and (select e from bw)
          and exists (select 1 from public.lead_attribution la
                       where la.email_key = li.email_key and la.is_paid))::numeric as paid_sales,
      (select coalesce(sum(m.leads),0) from public.daily_metrics m
         join public.ad_accounts a on a.account_id = m.account_id
        where m.level = 'account' and a.lead_tracking_status = 'working'
          and m.date between (select s from bw) and (select e from bw))::numeric as regs
  )
  select (select count(*) from l1)::bigint,
         (select count(*) from l1 join l3 using (email_key))::bigint,
         case when (select count(*) from l1) > 0
              then round((select count(*) from l1 join l3 using (email_key))::numeric * 100
                         / (select count(*) from l1), 2) end,
         t.l3_avg, t.l1_avg,
         c.s, c.e,
         case when b.regs > 0 then round(1000 * b.paid_sales / b.regs, 2) end,
         (select s from bw), (select e from bw)
    from tickets t, cohort c, buyers b
$function$;
REVOKE ALL ON FUNCTION public.measured_ascension() FROM public;
GRANT EXECUTE ON FUNCTION public.measured_ascension() TO authenticated, service_role;

-- ── step 5. golden tests ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.run_golden(p_golden_id text, p_trigger text DEFAULT 'manual'::text, p_deploy_ref text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare g record; v numeric; v_pass boolean; v_delta numeric; v_err text;
begin
  select * into g from golden_tests where golden_id = p_golden_id;
  if not found then return jsonb_build_object('error','no such golden'); end if;

  begin
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
       where is_new_sale and product_tier = 'L1_SILVER'
         and business_date between g.window_start and g.window_end;
    elsif g.metric_id = 'paid_l1_collected_gross' then
      select round(coalesce(sum(li.amount_received),0),2) into v from ledger_inflow li
       where li.product_tier = 'L1_SILVER' and li.is_new_sale
         and li.business_date between g.window_start and g.window_end
         and exists (select 1 from lead_attribution la where la.email_key = li.email_key and la.is_paid);
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
REVOKE ALL ON FUNCTION public.run_golden(text,text,text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION public.run_golden(text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.run_golden_tests(p_trigger text DEFAULT 'nightly', p_deploy_ref text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare g record; r jsonb; results jsonb := '[]'::jsonb; n_pass int := 0; n_fail int := 0; fails text := '';
begin
  for g in select golden_id from golden_tests order by golden_id loop
    r := public.run_golden(g.golden_id, p_trigger, p_deploy_ref);
    results := results || r;
    if coalesce((r->>'pass')::boolean, false) then n_pass := n_pass + 1;
    else n_fail := n_fail + 1;
         fails := fails || g.golden_id || ' (expected ' || (r->>'expected') ||
                  ', computed ' || coalesce(r->>'computed','none') || ') ';
    end if;
  end loop;

  if n_fail > 0 then
    insert into review_items (kind, ref_id, title, detail, evidence, status)
    values ('golden_failure', 'goldens-' || to_char(now(),'YYYY-MM-DD'),
            n_fail || ' verified historical figure' || case when n_fail = 1 then '' else 's' end || ' no longer reproduce',
            fails, jsonb_build_object('results', results, 'trigger', p_trigger, 'deploy_ref', p_deploy_ref), 'open');
  end if;

  return jsonb_build_object('pass', n_pass, 'fail', n_fail, 'results', results);
end $function$;
REVOKE ALL ON FUNCTION public.run_golden_tests(text,text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION public.run_golden_tests(text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.golden_status()
 RETURNS TABLE(golden_id text, metric_id text, window_start date, window_end date,
               expected_value numeric, computed_value numeric, delta numeric, pass boolean,
               error text, run_at timestamp with time zone, note text, verified_by text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select g.golden_id, g.metric_id, g.window_start, g.window_end, g.expected_value,
         r.computed_value, r.delta, r.pass, r.error, r.run_at, g.note, g.verified_by
    from golden_tests g
    left join lateral (
      select * from golden_runs gr where gr.golden_id = g.golden_id order by gr.run_at desc limit 1
    ) r on true
   order by coalesce(r.pass, false), g.golden_id
$function$;
REVOKE ALL ON FUNCTION public.golden_status() FROM public;
GRANT EXECUTE ON FUNCTION public.golden_status() TO authenticated, service_role;

-- seed audit-verified anchors
INSERT INTO public.golden_tests (golden_id, metric_id, window_start, window_end, expected_value, tolerance_abs, tolerance_pct, verified_by, note) VALUES
 ('meta_spend_2026_08','meta_spend','2026-08-01','2026-08-31',1002144.08,1,NULL,'audit-2026-09','August Meta account-level spend'),
 ('measured_registrations_2026_08','measured_registrations','2026-08-01','2026-08-31',3387,0,NULL,'audit-2026-09','Meta-reported registrations on tracking-working accounts'),
 ('cost_per_registration_2026_08','cost_per_registration','2026-08-01','2026-08-31',291.27,NULL,0.5,'audit-2026-09','working-account spend / Meta-reported registrations'),
 ('paid_l1_collected_gross_2026_08','paid_l1_collected_gross','2026-08-01','2026-08-31',727680.75,1,NULL,'audit-2026-09 (recomputed)','Audit stated 746981.48; recomputed under the single product-wide paid rule (lead_attribution.is_paid) it is 727680.75 — owner confirmation raised as a review item'),
 ('l1_collected_all_sources_2026_08','l1_collected_all_sources','2026-08-01','2026-08-31',1279269.57,1,NULL,'audit-2026-09','all L1 cash incl. organic and instalments'),
 ('all_tier_collected_2026_08','all_tier_collected','2026-08-01','2026-08-31',15332403.79,1,NULL,'audit-2026-09','every tier, August'),
 ('ledger_l1_new_sales_2026_01','ledger_l1_new_sales','2026-01-01','2026-01-31',151,0,NULL,'audit-2026-09','closed month'),
 ('ledger_l1_new_sales_2026_02','ledger_l1_new_sales','2026-02-01','2026-02-28',137,0,NULL,'audit-2026-09','closed month'),
 ('ledger_l1_new_sales_2026_03','ledger_l1_new_sales','2026-03-01','2026-03-31',355,0,NULL,'audit-2026-09','closed month'),
 ('ledger_l1_new_sales_2026_04','ledger_l1_new_sales','2026-04-01','2026-04-30',302,0,NULL,'audit-2026-09','closed month'),
 ('ledger_l1_new_sales_2026_05','ledger_l1_new_sales','2026-05-01','2026-05-31',258,0,NULL,'audit-2026-09','closed month'),
 ('ledger_l1_new_sales_2026_06','ledger_l1_new_sales','2026-06-01','2026-06-30',283,0,NULL,'audit-2026-09','closed month'),
 ('ledger_l1_new_sales_2026_07','ledger_l1_new_sales','2026-07-01','2026-07-31',248,0,NULL,'audit-2026-09','closed month')
ON CONFLICT (golden_id) DO UPDATE SET expected_value = excluded.expected_value,
  tolerance_abs = excluded.tolerance_abs, tolerance_pct = excluded.tolerance_pct,
  verified_by = excluded.verified_by, note = excluded.note;

-- ── step 6. deploy verification ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.deploys (
  deploy_ref text PRIMARY KEY,
  deployed_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  verify_status text NOT NULL DEFAULT 'pending' CHECK (verify_status IN ('pending','verified','failed')),
  goldens_pass int NOT NULL DEFAULT 0,
  goldens_fail int NOT NULL DEFAULT 0,
  invariants_diverged int NOT NULL DEFAULT 0,
  note text
);
GRANT SELECT ON public.deploys TO authenticated;
GRANT ALL ON public.deploys TO service_role;
ALTER TABLE public.deploys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deploys readable by signed-in users" ON public.deploys FOR SELECT TO authenticated USING (true);
CREATE POLICY "deploys managed by service role" ON public.deploys FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.verify_deploy(p_deploy_ref text, p_note text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare g jsonb; inv int; ok boolean;
begin
  insert into deploys (deploy_ref, note) values (p_deploy_ref, p_note)
    on conflict (deploy_ref) do update set note = coalesce(excluded.note, deploys.note);

  g := public.run_golden_tests('deploy', p_deploy_ref);

  select count(distinct check_id) into inv
    from reconciliations
   where check_id like 'inv\_%' and verdict = 'diverged'
     and checked_at > now() - interval '36 hours';

  ok := (g->>'fail')::int = 0 and coalesce(inv,0) = 0;

  update deploys set verified_at = now(),
    verify_status = case when ok then 'verified' else 'failed' end,
    goldens_pass = (g->>'pass')::int, goldens_fail = (g->>'fail')::int,
    invariants_diverged = coalesce(inv,0)
   where deploy_ref = p_deploy_ref;

  return jsonb_build_object('deploy_ref', p_deploy_ref, 'verified', ok,
    'goldens_pass', (g->>'pass')::int, 'goldens_fail', (g->>'fail')::int,
    'invariants_diverged', coalesce(inv,0), 'goldens', g->'results');
end $function$;
REVOKE ALL ON FUNCTION public.verify_deploy(text,text) FROM public, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_deploy(text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.deploy_status()
 RETURNS TABLE(deploy_ref text, deployed_at timestamptz, verified_at timestamptz,
               verify_status text, goldens_pass int, goldens_fail int, invariants_diverged int, note text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select deploy_ref, deployed_at, verified_at, verify_status, goldens_pass, goldens_fail,
         invariants_diverged, note
    from deploys order by deployed_at desc limit 10
$function$;
REVOKE ALL ON FUNCTION public.deploy_status() FROM public;
GRANT EXECUTE ON FUNCTION public.deploy_status() TO authenticated, service_role;

-- ── step 7. metric contracts ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.metric_contracts (
  metric_id text NOT NULL,
  version int NOT NULL DEFAULT 1,
  owner_definition text NOT NULL,
  unit text NOT NULL CHECK (unit IN ('inr','count','ratio','percent')),
  basis text NOT NULL CHECK (basis IN ('ex_gst','gross','none')),
  grain text NOT NULL,
  source_precedence text,
  source_function text,
  source_fingerprint text,
  is_current boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric_id, version)
);
GRANT SELECT ON public.metric_contracts TO authenticated;
GRANT ALL ON public.metric_contracts TO service_role;
ALTER TABLE public.metric_contracts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "contracts readable by signed-in users" ON public.metric_contracts FOR SELECT TO authenticated USING (true);
CREATE POLICY "contracts managed by service role" ON public.metric_contracts FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER metric_contracts_updated_at BEFORE UPDATE ON public.metric_contracts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- a definition may not change inside a version; a new version resets baselines
CREATE OR REPLACE FUNCTION public.metric_contract_versioning() RETURNS trigger
 LANGUAGE plpgsql SET search_path TO 'public' AS $function$
begin
  if TG_OP = 'UPDATE' then
    if (new.owner_definition is distinct from old.owner_definition
        or new.unit is distinct from old.unit
        or new.basis is distinct from old.basis
        or new.grain is distinct from old.grain)
       and new.version = old.version then
      raise exception 'Metric % is contracted at version %: change the definition by inserting a new version, never by editing this one', old.metric_id, old.version;
    end if;
  end if;
  if TG_OP = 'INSERT' and new.is_current then
    update public.metric_contracts c set is_current = false
      where c.metric_id = new.metric_id and c.version <> new.version and c.is_current;
    -- a redefined metric may not be compared against bands built on the old one
    delete from public.metric_baselines b where b.metric_id = new.metric_id;
  end if;
  return new;
end $function$;
CREATE TRIGGER metric_contracts_versioning
  BEFORE INSERT OR UPDATE ON public.metric_contracts
  FOR EACH ROW EXECUTE FUNCTION public.metric_contract_versioning();

CREATE OR REPLACE FUNCTION public.contract_eval(p_metric_id text, p_start date, p_end date)
 RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare c record; v numeric; ok boolean := true; why text := null;
begin
  select * into c from metric_contracts where metric_id = p_metric_id and is_current;
  if not found then
    return jsonb_build_object('metric_id', p_metric_id, 'contracted', false,
      'reason', 'no current contract — this figure may not be rendered');
  end if;

  select s.value into v from public.metric_series(p_start, p_end, 'month') s
   where s.metric_id = p_metric_id limit 1;

  if v is null then ok := false; why := 'no value for the window';
  elsif c.unit = 'inr' and v < 0 then ok := false; why := 'money may never be negative';
  elsif c.unit = 'percent' and (v < 0 or v > 100) then ok := false; why := 'a percentage outside 0–100';
  elsif c.unit = 'ratio' and v < 0 then ok := false; why := 'a ratio may never be negative';
  end if;

  return jsonb_build_object('metric_id', p_metric_id, 'contracted', true, 'version', c.version,
    'unit', c.unit, 'basis', c.basis, 'value', v, 'sane', ok, 'why', why,
    'owner_definition', c.owner_definition);
end $function$;
REVOKE ALL ON FUNCTION public.contract_eval(text,date,date) FROM public;
GRANT EXECUTE ON FUNCTION public.contract_eval(text,date,date) TO authenticated, service_role;

-- nightly: has the calculation behind a contracted metric changed without a version bump?
CREATE OR REPLACE FUNCTION public.contract_drift()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
      insert into reconciliations (check_id, for_date, primary_value, primary_source,
                                   witness_value, witness_source, divergence_pct, verdict, note)
      values ('contract_drift', public.business_date(now()), c.version, 'metric contract',
              null, c.source_function, null, 'diverged',
              'The calculation behind ' || c.metric_id || ' changed while the contract stayed at version ' || c.version);
      insert into review_items (kind, ref_id, title, detail, evidence, status)
      values ('contract_drift', c.metric_id,
              'The way ' || c.metric_id || ' is calculated changed without a new definition version',
              'Confirm the new calculation, then record a new contract version so comparison bands reset.',
              jsonb_build_object('metric_id', c.metric_id, 'version', c.version,
                                 'source_function', c.source_function), 'open');
    end if;
  end loop;

  if drift = 0 then
    insert into reconciliations (check_id, for_date, primary_value, primary_source,
                                 witness_value, witness_source, divergence_pct, verdict, note)
    values ('contract_drift', public.business_date(now()),
            (select count(*) from metric_contracts where is_current), 'metric contract',
            (select count(*) from metric_contracts where is_current), 'live calculation', 0, 'match',
            'Every contracted metric is still calculated the way its definition says');
  end if;

  return jsonb_build_object('contracts', (select count(*) from metric_contracts where is_current),
                            'drifted', drift, 'detail', details);
end $function$;
REVOKE ALL ON FUNCTION public.contract_drift() FROM public, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_drift() TO service_role;

INSERT INTO public.metric_contracts (metric_id, version, owner_definition, unit, basis, grain, source_precedence, source_function, note) VALUES
 ('meta_spend',1,'Meta account-level spend for the window, every ad account, as reported by the Meta API. The ledger and the agency sheet are never a source for spend.','inr','ex_gst','day','Meta API always','metric_series','audit-2026-09'),
 ('registrations',1,'Meta-reported leads on ad accounts whose lead tracking is working. This is the ad-platform sense of "registration" — not CRM leads and not Zoom registrants.','count','none','day','Meta API always','metric_series','audit-2026-09'),
 ('cost_per_registration',1,'Spend on tracking-working accounts divided by Meta-reported registrations on those same accounts.','inr','ex_gst','day','Meta API always','metric_series','audit-2026-09'),
 ('show_up_rate',1,'Attendees from webinar sessions that reported a registrant count, divided by deduplicated registrants for the same sessions. Sessions with no registrant count are excluded from both sides and the day is marked partial.','percent','none','event day','Zoom always; CRM tags are only a witness','metric_series','audit-2026-09'),
 ('retention_60',1,'People still present sixty minutes after start, as a share of attendees.','percent','none','event day','Zoom always','metric_series','audit-2026-09'),
 ('sales_per_1000_leads',1,'L1 sales whose buyer joins a paid-attributed lead, per 1,000 Meta-reported registrations.','count','none','day','TagMango enrolments for recent days, ledger for settled days','metric_series','audit-2026-09'),
 ('cost_per_sale',1,'Spend on tracking-working accounts divided by paid-attributed L1 sales.','inr','ex_gst','day','Meta API for spend; enrolments for the count','metric_series','audit-2026-09'),
 ('front_end_roas',1,'First-time L1 collections from paid-attributed buyers, divided by 1.18 to remove GST, over Meta spend for the same window. Organic and podcast buyers and instalments on earlier sales are excluded.','ratio','ex_gst','day','Ledger for money; Meta API for spend','metric_series','audit-2026-09'),
 ('paid_collected_exgst',1,'First-time L1 collections from paid-attributed buyers, ex-GST.','inr','ex_gst','day','Ledger always','metric_series','audit-2026-09'),
 ('collected',1,'All L1 cash received in the window including organic buyers and instalments from earlier sales. Never an ad-performance figure.','inr','gross','day','Ledger always','metric_series','audit-2026-09'),
 ('paid_l1_collected_gross',1,'First-time L1 collections from paid-attributed buyers, as collected, GST included.','inr','gross','day','Ledger always','ledger_paid_daily','audit-2026-09'),
 ('l1_collected_all_sources',1,'Every rupee of L1 cash in the window, all sources, GST included.','inr','gross','day','Ledger always','ledger_paid_daily','audit-2026-09'),
 ('all_tier_collected',1,'Every rupee collected across all product tiers in the window.','inr','gross','day','Ledger always','ledger_daily','audit-2026-09'),
 ('ledger_l1_new_sales',1,'Rows tagged as a new L1 sale in the accounts ledger for the window.','count','none','business day','Ledger for settled days','metric_components','audit-2026-09')
ON CONFLICT (metric_id, version) DO NOTHING;

-- registry rows so the harness reports through the one trust surface
INSERT INTO public.proof_registry (check_id, family, label, plain, expected_noise, fp_budget_per_30d, tolerance_note, structural_note, enabled, ord) VALUES
 ('contract_drift','contract','Metric definitions match their calculations','Every headline number is still worked out the way its written definition says.','Fires only when a calculation is changed without recording a new definition version.',1,'Exact — a fingerprint either matches or it does not.','A deliberate redefinition should be recorded as a new version, which clears this.',true,90)
ON CONFLICT (check_id) DO NOTHING;