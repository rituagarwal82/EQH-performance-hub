ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS source_inferred text,
  ADD COLUMN IF NOT EXISTS inference_basis text;

COMMENT ON COLUMN public.leads.source_inferred IS
  'Last-resort inferred acquisition source. NEVER written when utm_source is present. Display must mark it as inferred.';
COMMENT ON COLUMN public.leads.inference_basis IS
  'The exact tag that produced source_inferred. Owner rule 11 Sep: lifecycle tags are not sources.';

CREATE OR REPLACE FUNCTION public.infer_lead_source(p_tags text[])
RETURNS TABLE (source_inferred text, inference_basis text)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  -- Owner-set 11 Sep: ONLY these tag families may imply a source. Everything
  -- else stays honestly "no source recorded" — lifecycle tags such as
  -- 'next-chapter-showcase-registration' describe an existing customer's
  -- interest, not how they were acquired.
  select v.src, v.basis
  from (
    select 'team_sd'::text as src, 'sd'::text as basis, 1 as ord
    union all select 'team_sx', 'sx', 2
    union all select 'sd_pw_funnel', 'pw-lead', 3
    union all select 'sd_pw_funnel', 'lead - pw1 - registered', 4
    union all select 'w1_funnel', 'lead - w1 - registered', 5
    union all select 'discover_tool', 'discover_your_hidden_life_drivers', 6
  ) v
  where v.basis = any(coalesce(p_tags, '{}'::text[]))
  -- Funnel tags are more specific than a bare team tag, so they win.
  order by case when v.ord >= 3 then 0 else 1 end, v.ord
  limit 1;
$$;

REVOKE ALL ON FUNCTION public.infer_lead_source(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.infer_lead_source(text[]) TO service_role;

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
    FROM LATERAL public.infer_lead_source(l.tags) i
   WHERE coalesce(l.utm_source, '') = ''
     AND (p_since IS NULL OR l.business_date >= p_since)
     AND (l.source_inferred IS DISTINCT FROM i.source_inferred
          OR l.inference_basis IS DISTINCT FROM i.inference_basis);
  GET DIAGNOSTICS n = ROW_COUNT;

  -- A real recorded source always wins: never leave an inferred value beside one.
  UPDATE public.leads
     SET source_inferred = NULL, inference_basis = NULL
   WHERE coalesce(utm_source, '') <> ''
     AND (source_inferred IS NOT NULL OR inference_basis IS NOT NULL);

  RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_lead_source_inference(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_lead_source_inference(date) TO service_role;