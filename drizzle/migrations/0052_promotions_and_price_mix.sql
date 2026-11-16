-- A promotion is a fact about the price, not a footnote. Without it a fall in
-- return reads as a fall in performance.
CREATE TABLE IF NOT EXISTS public.promotions (
  code text PRIMARY KEY,
  name text NOT NULL,
  discounted_price numeric NOT NULL,
  list_price numeric NOT NULL DEFAULT 6990,
  starts_on date,
  ends_on date,
  dates_confirmed boolean NOT NULL DEFAULT false,
  note text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.promotions TO authenticated;
GRANT SELECT ON public.promotions TO anon;
GRANT ALL ON public.promotions TO service_role;

ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "promotions readable" ON public.promotions;
CREATE POLICY "promotions readable" ON public.promotions FOR SELECT USING (true);
DROP POLICY IF EXISTS "promotions editable by signed-in" ON public.promotions;
CREATE POLICY "promotions editable by signed-in" ON public.promotions FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO public.promotions (code, name, discounted_price, list_price, starts_on, ends_on, dates_confirmed, note)
VALUES (
  'WBT-EQDESPCLOFFER',
  'Ganesh Mahotsav special offer',
  4989.99,
  6990,
  (SELECT min(business_date) FROM public.tm_payments WHERE coupon_code = 'WBT-EQDESPCLOFFER' AND amount_inr > 0),
  NULL,
  false,
  'Offered to every lead. Start date is the first use seen in the data and the end date is not set — both to be confirmed by the owner.'
)
ON CONFLICT (code) DO NOTHING;

-- Every L1 payment that actually carried money, with the promotion it used.
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
  coalesce(pr.list_price, 6990) AS list_price,
  pr.code IS NOT NULL AS on_promotion,
  pr.name AS promotion_name,
  greatest(coalesce(pr.list_price, 6990) - p.amount_inr, 0) AS discount_given
FROM public.tm_payments p
JOIN public.products pp ON pp.mango_id = p.mango_id AND pp.tier = 'L1_SILVER'
LEFT JOIN public.promotions pr ON pr.code = p.coupon_code
WHERE p.amount_inr > 0
  AND lower(coalesce(p.status,'')) IN ('completed','captured','success','successful','paid','active');

GRANT SELECT ON public.l1_charged_payments TO authenticated, service_role, eqh_ask_ro;

-- Full price versus discounted, by day.
CREATE OR REPLACE FUNCTION public.price_mix_daily(p_start date, p_end date)
RETURNS TABLE (
  business_date date,
  sales bigint,
  full_price_sales bigint,
  discounted_sales bigint,
  promotion_sales bigint,
  cash_received numeric,
  avg_sale_value numeric,
  discount_given numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    c.business_date,
    count(*)::bigint,
    count(*) FILTER (WHERE c.amount_inr >= 6900)::bigint,
    count(*) FILTER (WHERE c.amount_inr < 6900)::bigint,
    count(*) FILTER (WHERE c.on_promotion)::bigint,
    sum(c.amount_inr)::numeric,
    round(avg(c.amount_inr), 2)::numeric,
    sum(c.discount_given)::numeric
  FROM public.l1_charged_payments c
  WHERE c.business_date BETWEEN p_start AND p_end
  GROUP BY c.business_date
  ORDER BY c.business_date;
$$;

-- The same split by where the buyer came from.
CREATE OR REPLACE FUNCTION public.price_mix_by_source(p_start date, p_end date)
RETURNS TABLE (
  source text,
  sales bigint,
  full_price_sales bigint,
  discounted_sales bigint,
  cash_received numeric,
  avg_sale_value numeric,
  discount_given numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    coalesce(a.channel, 'not yet identified') AS source,
    count(*)::bigint,
    count(*) FILTER (WHERE c.amount_inr >= 6900)::bigint,
    count(*) FILTER (WHERE c.amount_inr < 6900)::bigint,
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

-- What the promotion has done to the average sale value, week by week.
CREATE OR REPLACE FUNCTION public.price_mix_weekly(p_code text DEFAULT NULL)
RETURNS TABLE (
  week_start date,
  sales bigint,
  promotion_sales bigint,
  avg_sale_value numeric,
  discount_given numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    date_trunc('week', c.business_date)::date AS week_start,
    count(*)::bigint,
    count(*) FILTER (WHERE p_code IS NULL AND c.on_promotion OR c.coupon_code = p_code)::bigint,
    round(avg(c.amount_inr), 2)::numeric,
    sum(c.discount_given)::numeric
  FROM public.l1_charged_payments c
  WHERE c.business_date >= coalesce(
    (SELECT min(business_date) FROM public.l1_charged_payments x
      WHERE (p_code IS NULL AND x.on_promotion) OR x.coupon_code = p_code) - interval '28 days',
    current_date - interval '84 days')::date
  GROUP BY 1
  ORDER BY 1;
$$;

-- Everything a promotion has cost, since its first use in the data.
CREATE OR REPLACE FUNCTION public.promotion_totals()
RETURNS TABLE (
  code text,
  name text,
  first_used date,
  last_used date,
  sales bigint,
  cash_received numeric,
  discount_given numeric,
  avg_sale_value numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    pr.code, pr.name,
    min(c.business_date), max(c.business_date),
    count(c.payment_id)::bigint,
    coalesce(sum(c.amount_inr), 0)::numeric,
    coalesce(sum(c.discount_given), 0)::numeric,
    round(avg(c.amount_inr), 2)::numeric
  FROM public.promotions pr
  LEFT JOIN public.l1_charged_payments c ON c.coupon_code = pr.code
  GROUP BY pr.code, pr.name
  ORDER BY 3 NULLS LAST;
$$;

-- Which promotions touch a window — for the banner on Today and Agencies.
CREATE OR REPLACE FUNCTION public.promotions_in_window(p_start date, p_end date)
RETURNS TABLE (
  code text,
  name text,
  discounted_price numeric,
  list_price numeric,
  starts_on date,
  ends_on date,
  dates_confirmed boolean,
  sales_in_window bigint,
  discount_in_window numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    pr.code, pr.name, pr.discounted_price, pr.list_price, pr.starts_on, pr.ends_on, pr.dates_confirmed,
    count(c.payment_id)::bigint,
    coalesce(sum(c.discount_given), 0)::numeric
  FROM public.promotions pr
  LEFT JOIN public.l1_charged_payments c
    ON c.coupon_code = pr.code AND c.business_date BETWEEN p_start AND p_end
  WHERE pr.is_active
  GROUP BY pr.code, pr.name, pr.discounted_price, pr.list_price, pr.starts_on, pr.ends_on, pr.dates_confirmed
  HAVING count(c.payment_id) > 0
  ORDER BY 8 DESC;
$$;

GRANT EXECUTE ON FUNCTION public.price_mix_daily(date, date) TO authenticated, service_role, eqh_ask_ro;
GRANT EXECUTE ON FUNCTION public.price_mix_by_source(date, date) TO authenticated, service_role, eqh_ask_ro;
GRANT EXECUTE ON FUNCTION public.price_mix_weekly(text) TO authenticated, service_role, eqh_ask_ro;
GRANT EXECUTE ON FUNCTION public.promotion_totals() TO authenticated, service_role, eqh_ask_ro;
GRANT EXECUTE ON FUNCTION public.promotions_in_window(date, date) TO authenticated, service_role, eqh_ask_ro;