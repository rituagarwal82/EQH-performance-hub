CREATE OR REPLACE FUNCTION public.regime_boundaries(p_start date, p_end date)
RETURNS TABLE(event_key text, agency_code text, boundary_date date, label text, plain text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $function$
  SELECT r.event_key, r.agency_code, r.boundary_date, r.label, r.plain
    FROM public.regime_events r
   WHERE r.enabled
     AND p_start IS NOT NULL AND p_end IS NOT NULL
     AND r.boundary_date > p_start AND r.boundary_date <= p_end
   ORDER BY r.boundary_date;
$function$;