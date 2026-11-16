create or replace function public.run_golden(p_golden_id text, p_trigger text default 'manual', p_deploy_ref text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare g record; v numeric; v_pass boolean; v_delta numeric; v_err text;
begin
  select * into g from golden_tests where golden_id = p_golden_id;
  if not found then return jsonb_build_object('error','no such golden'); end if;

  begin
    if g.metric_id = 'meta_spend' then
      select coalesce(sum(spend),0) into v from daily_metrics
       where level = 'account' and date between g.window_start and g.window_end;
    elsif g.metric_id = 'ledger_l1_new_sales' then
      -- The engine's own L1 definition, the one proof_closed_months uses.
      select count(*)::numeric into v from ledger_inflow
       where is_new_sale and product_tier = 'L1_SILVER'
         and business_date between g.window_start and g.window_end;
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
end $$;

revoke execute on function public.run_golden(text, text, text) from public, anon, authenticated;
grant execute on function public.run_golden(text, text, text) to service_role;