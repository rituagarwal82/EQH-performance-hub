CREATE OR REPLACE FUNCTION public.source_month_matrix(p_start date, p_end date)
RETURNS TABLE (
  month text,
  channel text,
  source text,
  confidence text,
  leads bigint,
  sales_team bigint,
  sales_paid bigint,
  cash numeric
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  WITH ft AS (
    SELECT DISTINCT ON (l.email_key) l.email_key, u.unified_source, u.unified_channel, u.unified_confidence
      FROM public.leads l
      JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
     WHERE l.email_key IS NOT NULL
     ORDER BY l.email_key, l.captured_at NULLS LAST, l.lead_id
  ),
  sales AS (
    SELECT to_char(li.business_date,'YYYY-MM') AS m,
           coalesce(ft.unified_channel,'No lead record') AS ch,
           coalesce(ft.unified_source,'No lead record') AS src,
           coalesce(ft.unified_confidence,'unknown') AS conf,
           count(*) FILTER (WHERE li.is_new_sale) AS s_team,
           count(*) FILTER (WHERE li.counts_as_sale) AS s_paid,
           sum(li.amount_received) AS cash
      FROM public.ledger_inflow li
      LEFT JOIN ft ON ft.email_key = li.email_key
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND (li.is_new_sale OR li.counts_as_sale)
     GROUP BY 1,2,3,4
  ),
  lead_counts AS (
    SELECT to_char(l.business_date,'YYYY-MM') AS m,
           u.unified_channel AS ch, u.unified_source AS src, u.unified_confidence AS conf,
           count(*) AS leads
      FROM public.leads l
      JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
     WHERE l.business_date BETWEEN p_start AND p_end
     GROUP BY 1,2,3,4
  )
  SELECT coalesce(s.m, c.m) AS month,
         coalesce(s.ch, c.ch) AS channel,
         coalesce(s.src, c.src) AS source,
         coalesce(s.conf, c.conf) AS confidence,
         coalesce(c.leads, 0) AS leads,
         coalesce(s.s_team, 0) AS sales_team,
         coalesce(s.s_paid, 0) AS sales_paid,
         coalesce(s.cash, 0) AS cash
    FROM sales s
    FULL OUTER JOIN lead_counts c
      ON c.m = s.m AND c.ch = s.ch AND c.src = s.src
   ORDER BY 1 DESC, 8 DESC, 5 DESC;
$$;

REVOKE ALL ON FUNCTION public.source_month_matrix(date,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.source_month_matrix(date,date) TO service_role;
