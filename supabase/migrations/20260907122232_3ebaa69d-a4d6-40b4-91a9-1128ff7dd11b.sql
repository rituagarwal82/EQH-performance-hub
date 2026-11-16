CREATE OR REPLACE VIEW public.buyer_phone_candidates
WITH (security_invoker = true) AS
 WITH buyers AS (
         SELECT DISTINCT i.email_key
           FROM ledger_inflow i
          WHERE i.email_key IS NOT NULL AND i.email_key <> ''::text AND NOT (EXISTS ( SELECT 1
                   FROM lead_attribution_mv a
                  WHERE a.email_key = i.email_key))
        )
 SELECT b.email_key,
    l.email_key AS lead_email_key,
    bp.phone_key
   FROM buyers b
     JOIN buyer_phones bp ON bp.email_key = b.email_key
     JOIN leads l ON l.phone_key = bp.phone_key
  WHERE l.email_key IS NOT NULL AND l.email_key <> ''::text AND l.email_key <> b.email_key;

CREATE OR REPLACE VIEW public.buyer_lead_link
WITH (security_invoker = true) AS
 SELECT i.email_key,
    i.email_key AS lead_email_key,
    'email'::text AS match_basis
   FROM ( SELECT DISTINCT ledger_inflow.email_key
           FROM ledger_inflow
          WHERE ledger_inflow.email_key IS NOT NULL AND ledger_inflow.email_key <> ''::text) i
     JOIN lead_attribution_mv a ON a.email_key = i.email_key
UNION ALL
 SELECT c.email_key,
    min(c.lead_email_key) AS lead_email_key,
    'phone'::text AS match_basis
   FROM buyer_phone_candidates c
  GROUP BY c.email_key
 HAVING count(DISTINCT c.lead_email_key) = 1;