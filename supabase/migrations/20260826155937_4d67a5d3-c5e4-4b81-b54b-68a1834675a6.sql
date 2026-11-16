CREATE OR REPLACE FUNCTION public.reapply_source_map()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  UPDATE public.ledger_inflow l
  SET source_code = coalesce(m.code, 'UNASSIGNED')
  FROM (SELECT btrim(raw) AS raw, code FROM public.source_map) m
  WHERE btrim(coalesce(l.source_of_student_raw, '')) = m.raw
    AND l.source_code IS DISTINCT FROM m.code;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reapply_source_map() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.reapply_source_map() TO service_role;