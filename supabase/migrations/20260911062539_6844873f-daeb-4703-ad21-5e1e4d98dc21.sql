CREATE OR REPLACE FUNCTION public.refresh_lead_source_inference(p_since date DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n integer;
BEGIN
  UPDATE public.leads l
     SET source_inferred = i.source_inferred,
         inference_basis = i.inference_basis
    FROM (
      SELECT x.lead_id, f.source_inferred, f.inference_basis
        FROM public.leads x
        CROSS JOIN LATERAL public.infer_lead_source(x.tags) f
       WHERE coalesce(x.utm_source, '') = ''
         AND (p_since IS NULL OR x.business_date >= p_since)
    ) i
   WHERE i.lead_id = l.lead_id
     AND (l.source_inferred IS DISTINCT FROM i.source_inferred
          OR l.inference_basis IS DISTINCT FROM i.inference_basis);
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE public.leads
     SET source_inferred = NULL, inference_basis = NULL
   WHERE coalesce(utm_source, '') <> ''
     AND (source_inferred IS NOT NULL OR inference_basis IS NOT NULL);

  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_lead_source_inference(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_lead_source_inference(date) TO service_role;