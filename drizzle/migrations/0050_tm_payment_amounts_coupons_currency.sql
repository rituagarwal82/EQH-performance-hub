ALTER TABLE public.tm_payments
  ADD COLUMN IF NOT EXISTS amount_inr numeric,
  ADD COLUMN IF NOT EXISTS list_price_inr numeric,
  ADD COLUMN IF NOT EXISTS discount_inr numeric,
  ADD COLUMN IF NOT EXISTS coupon_code text,
  ADD COLUMN IF NOT EXISTS exchange_rate numeric,
  ADD COLUMN IF NOT EXISTS sale_status text,
  ADD COLUMN IF NOT EXISTS fx_basis text;

COMMENT ON COLUMN public.tm_payments.amount_inr IS 'The order in rupees. INR orders are taken as charged; other currencies use the exchange rate stored on the order, else TagMango''s own rupee figure for it. NULL means it could not be converted and must never be added to a rupee total.';
COMMENT ON COLUMN public.tm_payments.list_price_inr IS 'TagMango mangoPrice in rupees, before GST and before any coupon — the full price the offer was listed at.';
COMMENT ON COLUMN public.tm_payments.fx_basis IS 'inr_native | order_rate | tagmango_inr | unconvertible';

CREATE OR REPLACE FUNCTION public.tm_order_inr_amount(p_raw jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN coalesce(nullif(p_raw->>'subscriberCurrency',''),'INR') = 'INR'
      THEN (p_raw->>'amount')::numeric
    WHEN coalesce((p_raw->>'exchangeRate')::numeric, 0) > 1
      THEN round((p_raw->>'amount')::numeric * (p_raw->>'exchangeRate')::numeric, 2)
    WHEN (p_raw->'inr'->>'afterDiscountAmount') IS NOT NULL
      THEN (p_raw->'inr'->>'afterDiscountAmount')::numeric
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.tm_order_fx_basis(p_raw jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN coalesce(nullif(p_raw->>'subscriberCurrency',''),'INR') = 'INR' THEN 'inr_native'
    WHEN coalesce((p_raw->>'exchangeRate')::numeric, 0) > 1 THEN 'order_rate'
    WHEN (p_raw->'inr'->>'afterDiscountAmount') IS NOT NULL THEN 'tagmango_inr'
    ELSE 'unconvertible'
  END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_tm_payments(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE v_count integer;
BEGIN
  WITH upserted AS (
    INSERT INTO public.tm_payments (
      payment_id, mango_id, buyer_email, buyer_phone, amount_gross, amount_net,
      currency, status, paid_at, business_date, raw, synced_at,
      amount_inr, list_price_inr, discount_inr, coupon_code, exchange_rate, sale_status, fx_basis)
    SELECT
      r->>'payment_id',
      nullif(r->>'mango_id',''),
      nullif(r->>'buyer_email',''),
      nullif(r->>'buyer_phone',''),
      coalesce((r->>'amount_gross')::numeric, 0),
      round(coalesce((r->>'amount_gross')::numeric, 0) / 1.18, 2),
      coalesce(nullif(r->>'currency',''), 'INR'),
      nullif(r->>'status',''),
      nullif(r->>'paid_at','')::timestamptz,
      public.business_date(nullif(r->>'paid_at','')::timestamptz),
      r->'raw',
      now(),
      public.tm_order_inr_amount(r->'raw'),
      (r->'raw'->'inr'->>'mangoPrice')::numeric,
      (r->'raw'->'inr'->>'discount')::numeric,
      coalesce(nullif(r->'raw'->>'coupon',''), nullif(r->'raw'->'inr'->>'code','')),
      (r->'raw'->>'exchangeRate')::numeric,
      nullif(r->'raw'->>'salePurchaseStatus',''),
      public.tm_order_fx_basis(r->'raw')
    FROM jsonb_array_elements(p_rows) AS r
    ON CONFLICT (payment_id) DO UPDATE SET
      mango_id = excluded.mango_id,
      buyer_email = excluded.buyer_email,
      buyer_phone = excluded.buyer_phone,
      amount_gross = excluded.amount_gross,
      amount_net = excluded.amount_net,
      currency = excluded.currency,
      status = excluded.status,
      paid_at = excluded.paid_at,
      business_date = excluded.business_date,
      raw = excluded.raw,
      synced_at = now(),
      amount_inr = excluded.amount_inr,
      list_price_inr = excluded.list_price_inr,
      discount_inr = excluded.discount_inr,
      coupon_code = excluded.coupon_code,
      exchange_rate = excluded.exchange_rate,
      sale_status = excluded.sale_status,
      fx_basis = excluded.fx_basis
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$fn$;

UPDATE public.tm_payments p
SET amount_inr = public.tm_order_inr_amount(p.raw),
    fx_basis = public.tm_order_fx_basis(p.raw),
    list_price_inr = (p.raw->'inr'->>'mangoPrice')::numeric,
    discount_inr = (p.raw->'inr'->>'discount')::numeric,
    coupon_code = coalesce(nullif(p.raw->>'coupon',''), nullif(p.raw->'inr'->>'code','')),
    exchange_rate = (p.raw->>'exchangeRate')::numeric,
    sale_status = nullif(p.raw->>'salePurchaseStatus','')
WHERE p.raw IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sales_day_reconciliation(p_date date)
RETURNS TABLE (
  side text,
  email_key text,
  person_name text,
  first_at timestamptz,
  tagmango_inr numeric,
  list_price_inr numeric,
  coupon_code text,
  currency text,
  ledger_inr numeric,
  ledger_payment_type text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH tm AS (
    SELECT s.person_key AS email_key,
           min(pm.paid_at) AS first_at,
           sum(pm.amount_inr) AS tagmango_inr,
           max(pm.list_price_inr) AS list_price_inr,
           max(coalesce(pm.coupon_code, s.coupon_code)) AS coupon_code,
           max(pm.currency) AS currency
    FROM public.tm_sales s
    LEFT JOIN public.tm_payments pm
      ON lower(pm.buyer_email) = s.person_key AND pm.business_date = s.business_date
    WHERE s.business_date = p_date
    GROUP BY s.person_key
  ),
  led AS (
    SELECT i.email_key,
           min(i.payer_name) AS person_name,
           sum(i.amount_received) AS ledger_inr,
           max(i.payment_type) AS ledger_payment_type
    FROM public.ledger_inflow i
    WHERE i.business_date = p_date
      AND i.product_tier = 'L1_SILVER'
      AND i.is_new_sale IS TRUE
    GROUP BY i.email_key
  )
  SELECT
    CASE WHEN tm.email_key IS NULL THEN 'ledger_only'
         WHEN led.email_key IS NULL THEN 'tagmango_only'
         ELSE 'both' END,
    coalesce(tm.email_key, led.email_key),
    led.person_name,
    tm.first_at,
    tm.tagmango_inr,
    tm.list_price_inr,
    tm.coupon_code,
    coalesce(tm.currency, 'INR'),
    led.ledger_inr,
    led.ledger_payment_type
  FROM tm FULL OUTER JOIN led ON led.email_key = tm.email_key
  ORDER BY 1, 4 NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.sales_day_reconciliation(date) TO authenticated, service_role, eqh_ask_ro;
GRANT EXECUTE ON FUNCTION public.tm_order_inr_amount(jsonb) TO authenticated, service_role, eqh_ask_ro;
GRANT EXECUTE ON FUNCTION public.tm_order_fx_basis(jsonb) TO authenticated, service_role, eqh_ask_ro;