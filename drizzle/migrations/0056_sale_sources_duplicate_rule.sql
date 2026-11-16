CREATE OR REPLACE FUNCTION public.daily_sale_amount_groups(p_date date)
RETURNS TABLE(email_key text, payer_name text, amount numeric, sheet_rows int, platform_payments int, counted int, platform_dates date[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH s AS (
    SELECT coalesce(nullif(li.email_key,''), 'name:' || lower(li.payer_name)) AS k,
           li.payer_name, round(li.amount_received, 2) AS amt
    FROM ledger_inflow li
    WHERE li.business_date = p_date AND li.product_tier = 'L1_SILVER'
      AND li.is_new_sale AND li.counts_as_sale
  ), g AS (
    SELECT k, min(payer_name) AS payer_name, amt, count(*)::int AS n FROM s GROUP BY k, amt
  ), p AS (
    SELECT g.k, g.amt, count(t.payment_id)::int AS m, array_agg(DISTINCT t.business_date) FILTER (WHERE t.payment_id IS NOT NULL) AS dates
    FROM g LEFT JOIN tm_payments t
      ON lower(t.buyer_email) = g.k
     AND t.business_date BETWEEN p_date - 1 AND p_date + 1
     AND abs(coalesce(t.amount_inr, t.amount_gross) - g.amt) < 1
    GROUP BY g.k, g.amt
  )
  SELECT g.k, g.payer_name, g.amt, g.n, p.m,
         CASE WHEN p.m > 0 THEN least(g.n, p.m) ELSE 1 END,
         coalesce(p.dates, '{}')
  FROM g JOIN p ON p.k = g.k AND p.amt = g.amt;
$$;

CREATE OR REPLACE FUNCTION public.daily_sale_sources(p_date date)
 RETURNS TABLE(email_key text, payer_name text, rows_count integer, cash numeric, channel text, source text, paid_direct boolean, first_reg date, has_lead boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT coalesce(nullif(li.email_key,''), 'name:' || lower(li.payer_name)) AS k,
           li.payer_name, li.receipt_source, sa.channel, sa.source
    FROM ledger_inflow li LEFT JOIN sale_attribution sa ON sa.row_hash = li.row_hash
    WHERE li.business_date = p_date AND li.product_tier = 'L1_SILVER'
      AND li.is_new_sale AND li.counts_as_sale
  ), b AS (
    SELECT s.k, min(s.payer_name) AS payer_name, count(*)::int AS rows_count,
           min(s.channel) AS channel, min(s.source) AS source,
           bool_and(s.receipt_source NOT ILIKE 'TagMango%') AS paid_direct
    FROM s GROUP BY 1
  ), c AS (
    SELECT g.email_key AS k, sum(g.amount * g.counted) AS cash
    FROM daily_sale_amount_groups(p_date) g GROUP BY 1
  )
  SELECT b.k, b.payer_name, b.rows_count, c.cash, b.channel, b.source, b.paid_direct,
         (SELECT min(l.business_date) FROM leads l WHERE l.email_key = b.k),
         EXISTS (SELECT 1 FROM leads l WHERE l.email_key = b.k)
  FROM b JOIN c ON c.k = b.k;
$function$;

GRANT EXECUTE ON FUNCTION public.daily_sale_amount_groups(date) TO authenticated, service_role;