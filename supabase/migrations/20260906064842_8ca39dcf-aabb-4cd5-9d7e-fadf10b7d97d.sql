CREATE OR REPLACE FUNCTION public.run_golden_tests(p_trigger text DEFAULT 'manual'::text, p_deploy_ref text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare g record; v numeric; d numeric; ok boolean; err text;
        n_pass int := 0; n_fail int := 0; res jsonb := '[]'::jsonb; fails text := '';
begin
  for g in select * from golden_tests order by golden_id loop
    v := null; err := null; ok := null;
    begin
      v := public.run_golden(g.golden_id);
    exception when others then err := sqlerrm;
    end;

    if err is null and v is not null then
      d := abs(v - g.expected_value);
      ok := (g.tolerance_abs is not null and d <= g.tolerance_abs)
         or (g.tolerance_pct is not null and g.expected_value <> 0
             and d <= abs(g.expected_value) * g.tolerance_pct / 100.0)
         or (g.tolerance_abs is null and g.tolerance_pct is null and d = 0);
      if ok then n_pass := n_pass + 1;
      else n_fail := n_fail + 1; fails := fails || g.golden_id || ' '; end if;
    else
      n_fail := n_fail + 1; fails := fails || g.golden_id || ' ';
    end if;

    insert into golden_runs (golden_id, trigger_kind, deploy_ref, computed_value, delta, pass, error)
    values (g.golden_id, p_trigger, p_deploy_ref, v, d, ok, err);

    res := res || jsonb_build_object('golden_id', g.golden_id, 'expected', g.expected_value,
                                     'computed', v, 'delta', d, 'pass', ok, 'error', err);
  end loop;

  if n_fail > 0 then
    insert into review_items (kind, ref_id, title, detail, evidence, status)
    values ('golden_failure', 'goldens-' || public.business_date(now()),
            n_fail || ' verified figure(s) no longer reproduce',
            'These figures were signed off by hand and the code now returns something else: ' || fails,
            jsonb_build_object('results', res, 'trigger', p_trigger), 'open')
    on conflict (kind, coalesce(ref_id, '')) where status = 'open'
    do update set title = excluded.title, detail = excluded.detail,
                  evidence = excluded.evidence, updated_at = now();
  end if;

  return jsonb_build_object('pass', n_pass, 'fail', n_fail, 'results', res);
end $function$;
REVOKE EXECUTE ON FUNCTION public.run_golden_tests(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_golden_tests(text, text) TO service_role;