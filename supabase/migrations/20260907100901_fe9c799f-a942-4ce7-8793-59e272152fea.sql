
ALTER VIEW public.lead_attribution SET (security_invoker = on);
ALTER VIEW public.sync_health SET (security_invoker = on);
ALTER VIEW public.buyer_lead_link SET (security_invoker = on);
ALTER VIEW public.buyer_phones SET (security_invoker = on);
ALTER VIEW public.buyer_phone_candidates SET (security_invoker = on);
ALTER VIEW public.buyer_phone_conflicts SET (security_invoker = on);

REVOKE ALL ON public.lead_attribution FROM anon;
REVOKE ALL ON public.buyer_lead_link FROM anon;
REVOKE ALL ON public.buyer_phones FROM anon;
REVOKE ALL ON public.buyer_phone_candidates FROM anon;
REVOKE ALL ON public.buyer_phone_conflicts FROM anon;
REVOKE ALL ON public.lead_attribution_mv FROM anon;
