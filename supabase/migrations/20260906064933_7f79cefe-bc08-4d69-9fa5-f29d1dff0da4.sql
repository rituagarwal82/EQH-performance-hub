CREATE OR REPLACE FUNCTION public.run_golden_tests(p_trigger text DEFAULT 'manual'::text, p_deploy_ref text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare g record; r jsonb; n_pass int := 0; n_fail int := 0;
        res jsonb := '[]'::jsonb; fails text := '';
begin
  for g in select golden_id from golden_tests order by golden_id loop
    r := public.run_golden(g.golden_id, p_trigger, p_deploy_ref);
    if coalesce((r->>'pass')::boolean, false) then
      n_pass := n_pass + 1;
    else
      n_fail := n_fail + 1;
      fails := fails || g.golden_id || ' ';
    end if;
    res := res || r;
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