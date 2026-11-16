REVOKE ALL ON FUNCTION public.infer_lead_source(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_lead_source_inference(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.infer_lead_source(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_lead_source_inference(date) TO service_role;