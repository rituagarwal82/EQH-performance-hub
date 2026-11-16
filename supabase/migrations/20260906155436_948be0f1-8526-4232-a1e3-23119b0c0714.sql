ALTER VIEW public.buyer_phones SET (security_invoker = on);
ALTER VIEW public.buyer_phone_candidates SET (security_invoker = on);
ALTER VIEW public.buyer_phone_conflicts SET (security_invoker = on);
ALTER VIEW public.buyer_lead_link SET (security_invoker = on);
REVOKE EXECUTE ON FUNCTION public.ledger_unmatched_summary(date,date,text) FROM anon;