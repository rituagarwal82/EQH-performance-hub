-- Owner ruling, 22 Sep 2026: never assume a sale price. The bulk of Silver
-- sales are at the standing list price, but offers recur and overseas buyers
-- pay a different amount. Every money figure must rest on the cash actually
-- received, converted to rupees where the payment was in another currency.

INSERT INTO public.app_settings (key, value, description)
VALUES ('l1_list_price', '6990',
        'Standing list price of an L1 Silver seat. Used only to judge full price against discounted — never to value a sale.')
ON CONFLICT (key) DO NOTHING;

-- What this buyer was supposed to pay: the offer price when a live offer code
-- was used, otherwise the standing list price.
CREATE OR REPLACE FUNCTION public.l1_expected_price(p_coupon text, p_date date)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(
    (SELECT pr.discounted_price
       FROM public.promotions pr
      WHERE upper(pr.code) = upper(btrim(p_coupon))
        AND (pr.starts_on IS NULL OR p_date IS NULL OR p_date >= pr.starts_on)
        AND (pr.ends_on   IS NULL OR p_date IS NULL OR p_date <= pr.ends_on)
      ORDER BY pr.starts_on DESC NULLS LAST
      LIMIT 1),
    (SELECT nullif(value,'')::numeric FROM public.app_settings WHERE key = 'l1_list_price'),
    6990
  );
$$;
GRANT EXECUTE ON FUNCTION public.l1_expected_price(text, date) TO authenticated, service_role, eqh_ask_ro;

DROP VIEW IF EXISTS public.l1_charged_payments;
CREATE VIEW public.l1_charged_payments
WITH (security_invoker = true) AS
SELECT
  p.payment_id,
  p.business_date,
  lower(btrim(p.buyer_email)) AS email_key,
  p.amount_inr,
  p.amount_gross,
  p.currency,
  p.exchange_rate,
  p.coupon_code,
  coalesce((SELECT nullif(value,'')::numeric FROM public.app_settings WHERE key='l1_list_price'), 6990) AS list_price,
  public.l1_expected_price(p.coupon_code, p.business_date) AS expected_price,
  pr.code IS NOT NULL AS on_promotion,
  pr.name AS promotion_name,
  (upper(coalesce(p.currency,'INR')) <> 'INR') AS is_overseas,
  greatest(
    coalesce((SELECT nullif(value,'')::numeric FROM public.app_settings WHERE key='l1_list_price'), 6990)
      - p.amount_inr, 0) AS discount_given
FROM public.tm_payments p
JOIN public.products pp ON pp.mango_id = p.mango_id AND pp.tier = 'L1_SILVER'
LEFT JOIN public.promotions pr ON upper(pr.code) = upper(p.coupon_code)
WHERE p.amount_inr > 0
  AND lower(coalesce(p.status,'')) IN ('completed','captured','success','successful','paid','active');
GRANT SELECT ON public.l1_charged_payments TO authenticated, service_role, eqh_ask_ro;

DROP FUNCTION IF EXISTS public.price_mix_daily(date, date);
CREATE FUNCTION public.price_mix_daily(p_start date, p_end date)
RETURNS TABLE (
  business_date date,
  sales bigint,
  full_price_sales bigint,
  discounted_sales bigint,
  promotion_sales bigint,
  overseas_sales bigint,
  cash_received numeric,
  avg_sale_value numeric,
  discount_given numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    c.business_date,
    count(*)::bigint,
    count(*) FILTER (WHERE NOT c.on_promotion AND c.amount_inr >= c.list_price)::bigint,
    count(*) FILTER (WHERE c.on_promotion OR c.amount_inr < c.list_price)::bigint,
    count(*) FILTER (WHERE c.on_promotion)::bigint,
    count(*) FILTER (WHERE c.is_overseas)::bigint,
    sum(c.amount_inr)::numeric,
    round(avg(c.amount_inr), 2)::numeric,
    sum(c.discount_given)::numeric
  FROM public.l1_charged_payments c
  WHERE c.business_date BETWEEN p_start AND p_end
  GROUP BY c.business_date
  ORDER BY c.business_date;
$$;

DROP FUNCTION IF EXISTS public.price_mix_by_source(date, date);
CREATE FUNCTION public.price_mix_by_source(p_start date, p_end date)
RETURNS TABLE (
  source text,
  sales bigint,
  full_price_sales bigint,
  discounted_sales bigint,
  overseas_sales bigint,
  cash_received numeric,
  avg_sale_value numeric,
  discount_given numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    coalesce(a.channel, 'not yet identified') AS source,
    count(*)::bigint,
    count(*) FILTER (WHERE NOT c.on_promotion AND c.amount_inr >= c.list_price)::bigint,
    count(*) FILTER (WHERE c.on_promotion OR c.amount_inr < c.list_price)::bigint,
    count(*) FILTER (WHERE c.is_overseas)::bigint,
    sum(c.amount_inr)::numeric,
    round(avg(c.amount_inr), 2)::numeric,
    sum(c.discount_given)::numeric
  FROM public.l1_charged_payments c
  LEFT JOIN LATERAL (
    SELECT sa.channel
    FROM public.sale_attribution sa
    WHERE sa.email_key = c.email_key
    ORDER BY abs(sa.business_date - c.business_date)
    LIMIT 1
  ) a ON true
  WHERE c.business_date BETWEEN p_start AND p_end
  GROUP BY 1
  ORDER BY sum(c.amount_inr) DESC;
$$;

CREATE OR REPLACE FUNCTION public.realised_sale_value_weekly(p_weeks integer DEFAULT 8)
RETURNS TABLE (
  week_start date,
  sales bigint,
  cash_received numeric,
  avg_realised numeric,
  full_price_sales bigint,
  discounted_sales bigint,
  discount_given numeric,
  overseas_sales bigint,
  overseas_cash numeric,
  overseas_avg numeric,
  domestic_avg numeric,
  offers text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    date_trunc('week', c.business_date)::date,
    count(*)::bigint,
    sum(c.amount_inr)::numeric,
    round(avg(c.amount_inr), 2)::numeric,
    count(*) FILTER (WHERE NOT c.on_promotion AND c.amount_inr >= c.list_price)::bigint,
    count(*) FILTER (WHERE c.on_promotion OR c.amount_inr < c.list_price)::bigint,
    sum(c.discount_given)::numeric,
    count(*) FILTER (WHERE c.is_overseas)::bigint,
    coalesce(sum(c.amount_inr) FILTER (WHERE c.is_overseas), 0)::numeric,
    round(avg(c.amount_inr) FILTER (WHERE c.is_overseas), 2)::numeric,
    round(avg(c.amount_inr) FILTER (WHERE NOT c.is_overseas), 2)::numeric,
    string_agg(DISTINCT c.promotion_name, ', ')
  FROM public.l1_charged_payments c
  WHERE c.business_date >= (date_trunc('week', public.business_date(now()))
                            - (greatest(p_weeks,1) - 1) * interval '7 days')::date
  GROUP BY 1
  ORDER BY 1;
$$;
GRANT EXECUTE ON FUNCTION public.realised_sale_value_weekly(integer) TO authenticated, service_role, eqh_ask_ro;
GRANT EXECUTE ON FUNCTION public.price_mix_daily(date, date) TO authenticated, service_role, eqh_ask_ro;
GRANT EXECUTE ON FUNCTION public.price_mix_by_source(date, date) TO authenticated, service_role, eqh_ask_ro;