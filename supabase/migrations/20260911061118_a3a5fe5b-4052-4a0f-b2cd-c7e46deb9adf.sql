ALTER FUNCTION public.refresh_lead_attribution() SET statement_timeout = '600s';
ALTER FUNCTION public.refresh_lead_agency() SET statement_timeout = '600s';
ALTER FUNCTION public.resolve_lead_ad_refs(boolean, integer, integer) SET statement_timeout = '300s';