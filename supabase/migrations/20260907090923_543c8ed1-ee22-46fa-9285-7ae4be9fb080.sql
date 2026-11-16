REVOKE ALL ON FUNCTION public.refresh_lead_agency() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_lead_agency() TO service_role;