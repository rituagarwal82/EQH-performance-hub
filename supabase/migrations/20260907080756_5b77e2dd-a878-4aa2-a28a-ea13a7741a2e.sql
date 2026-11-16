REVOKE ALL ON public.lead_attribution_mv FROM anon, authenticated;
GRANT SELECT ON public.lead_attribution_mv TO service_role;