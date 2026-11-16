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
      insert into review_items (kind, ref_id, title, detail, evidence, status)
      values ('contract_drift', c.metric_id,
              'The way ' || c.metric_id || ' is calculated changed without a new definition version',
              'Confirm the new calculation, then record a new contract version so comparison bands reset.',
              jsonb_build_object('metric_id', c.metric_id, 'version', c.version,
                                 'source_function', c.source_function), 'open');
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
end $function$;
REVOKE EXECUTE ON FUNCTION public.contract_drift() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.contract_drift() TO service_role;