DROP FUNCTION IF EXISTS public.ledger_unassigned_queue(date, date, integer);

CREATE OR REPLACE FUNCTION public.ledger_unmatched_buyers(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER', p_limit integer DEFAULT 1000)
RETURNS TABLE(email_key text, email_raw text, payer_name text, first_date date, last_date date, sales bigint, collected numeric, rows_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT i.email_key,
         min(i.email_raw),
         min(i.payer_name),
         min(i.business_date),
         max(i.business_date),
         SUM(CASE WHEN i.is_new_sale THEN 1 ELSE 0 END)::bigint,
         SUM(i.amount_received)::numeric,
         count(*)::bigint
  FROM public.ledger_inflow i
  WHERE i.product_tier = p_tier
    AND i.business_date BETWEEN p_start AND p_end
    AND NOT EXISTS (SELECT 1 FROM public.lead_attribution a WHERE a.email_key = i.email_key)
  GROUP BY i.email_key
  ORDER BY SUM(i.amount_received) DESC
  LIMIT greatest(1, least(p_limit, 5000))
$$;

REVOKE EXECUTE ON FUNCTION public.ledger_unmatched_buyers(date, date, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_unmatched_buyers(date, date, text, integer) TO authenticated, service_role;