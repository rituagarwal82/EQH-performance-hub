ALTER TABLE public.products ADD COLUMN IF NOT EXISTS payment_route text;

INSERT INTO public.products (mango_id, title, tier, counts_as_sale, payment_route, price, currency)
VALUES
  ('64ba4a675161b1b6715be618','Life-Time Membership of the Energy Queens Hub','L1_SILVER',true,'FULL',5923.73,'INR'),
  ('65ab54552652ddcdb2753e0d','EMI Offer for the Energy Queen Membership','L1_SILVER',true,'EMI',2330.00,'INR'),
  ('6610fc44cc5c51ec4021b6c0','Energy Queens Hub: Book Your Seat','L1_SILVER',true,'BMS_DEPOSIT',1990.00,'INR'),
  ('6a79936c2e3b411312ab4cd2','Energy Queens Hub: Silver Membership','L1_SILVER',true,'BMS_BALANCE',5000.00,'INR')
ON CONFLICT (mango_id) DO UPDATE SET
  tier = EXCLUDED.tier,
  counts_as_sale = EXCLUDED.counts_as_sale,
  payment_route = EXCLUDED.payment_route;

UPDATE public.products
   SET tier = 'L3_DIAMOND', counts_as_sale = false, payment_route = NULL
 WHERE mango_id IN ('66112b0d83d0cc73c3b6916b','66112b5c83d0cc73c3b6c643');

CREATE TABLE IF NOT EXISTS public.tm_payments (
  payment_id text PRIMARY KEY,
  mango_id text REFERENCES public.products(mango_id),
  buyer_email text,
  buyer_phone text,
  amount_gross numeric(12,2) NOT NULL DEFAULT 0,
  amount_net numeric(12,2),
  currency text DEFAULT 'INR',
  status text,
  paid_at timestamptz,
  business_date date,
  raw jsonb,
  synced_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.tm_payments TO authenticated;
GRANT ALL ON public.tm_payments TO service_role;
ALTER TABLE public.tm_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read tm_payments" ON public.tm_payments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages tm_payments" ON public.tm_payments FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS tm_payments_email_paid_idx ON public.tm_payments (lower(btrim(buyer_email)), paid_at);
CREATE INDEX IF NOT EXISTS tm_payments_business_date_idx ON public.tm_payments (business_date);

CREATE TABLE IF NOT EXISTS public.tm_sales (
  sale_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_key text NOT NULL,
  first_payment_at timestamptz,
  business_date date,
  payment_route text,
  gross_collected numeric(12,2) NOT NULL DEFAULT 0,
  expected_gross numeric(12,2) NOT NULL DEFAULT 6990,
  is_fully_paid boolean NOT NULL DEFAULT false,
  payment_count integer NOT NULL DEFAULT 0,
  first_mango_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.tm_sales TO authenticated;
GRANT ALL ON public.tm_sales TO service_role;
ALTER TABLE public.tm_sales ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read tm_sales" ON public.tm_sales FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages tm_sales" ON public.tm_sales FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS tm_sales_business_date_idx ON public.tm_sales (business_date);

-- Upsert raw payments (immutable ledger, one row per money movement).
CREATE OR REPLACE FUNCTION public.upsert_tm_payments(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count integer;
BEGIN
  WITH upserted AS (
    INSERT INTO public.tm_payments (
      payment_id, mango_id, buyer_email, buyer_phone, amount_gross, amount_net,
      currency, status, paid_at, business_date, raw, synced_at)
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
      now()
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
      synced_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$$;

-- Rebuild sales from payments. One sale = one person x one L1 cohort (120-day window).
CREATE OR REPLACE FUNCTION public.rebuild_tm_sales()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM public.tm_sales;

  WITH captured AS (
    SELECT
      lower(btrim(p.buyer_email)) AS person_key,
      p.payment_id,
      p.mango_id,
      pr.payment_route,
      p.amount_gross,
      p.paid_at
    FROM public.tm_payments p
    JOIN public.products pr ON pr.mango_id = p.mango_id
    WHERE pr.tier = 'L1_SILVER'
      AND pr.counts_as_sale
      AND p.buyer_email IS NOT NULL
      AND btrim(p.buyer_email) <> ''
      AND p.paid_at IS NOT NULL
      AND lower(coalesce(p.status,'')) IN ('completed','captured','success','successful','paid','active')
  ), ordered AS (
    SELECT c.*, lag(c.paid_at) OVER (PARTITION BY c.person_key ORDER BY c.paid_at) AS prev_at
    FROM captured c
  ), marked AS (
    -- A payment more than 120 days after the previous one opens a new cohort.
    SELECT o.*,
      sum(CASE WHEN o.prev_at IS NULL OR o.paid_at > o.prev_at + interval '120 days' THEN 1 ELSE 0 END)
        OVER (PARTITION BY o.person_key ORDER BY o.paid_at ROWS UNBOUNDED PRECEDING) AS cohort
    FROM ordered o
  ), grouped AS (
    SELECT
      person_key,
      cohort,
      min(paid_at) AS first_payment_at,
      sum(amount_gross) AS gross_collected,
      count(*) AS payment_count,
      bool_or(payment_route LIKE 'BMS%') AS has_bms,
      bool_or(payment_route = 'EMI') AS has_emi,
      (array_agg(mango_id ORDER BY paid_at))[1] AS first_mango_id
    FROM marked
    GROUP BY person_key, cohort
  ), inserted AS (
    INSERT INTO public.tm_sales (
      person_key, first_payment_at, business_date, payment_route,
      gross_collected, expected_gross, is_fully_paid, payment_count, first_mango_id, updated_at)
    SELECT
      person_key,
      first_payment_at,
      public.business_date(first_payment_at),
      CASE WHEN has_bms THEN 'BMS' WHEN has_emi THEN 'EMI' ELSE 'FULL' END,
      gross_collected,
      6990,
      gross_collected >= 6900,
      payment_count,
      first_mango_id,
      now()
    FROM grouped
    WHERE gross_collected > 0
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM inserted;
  RETURN v_count;
END;
$$;

-- Daily rollup for the /sales screen.
CREATE OR REPLACE FUNCTION public.tm_sales_daily(p_start date, p_end date)
RETURNS TABLE(business_date date, payment_route text, sales bigint, gross numeric, net numeric, partial bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    s.business_date,
    s.payment_route,
    count(*)::bigint,
    sum(s.gross_collected)::numeric,
    round(sum(s.gross_collected) / 1.18, 2)::numeric,
    count(*) FILTER (WHERE NOT s.is_fully_paid)::bigint
  FROM public.tm_sales s
  WHERE s.business_date >= p_start AND s.business_date <= p_end
  GROUP BY s.business_date, s.payment_route
  ORDER BY s.business_date DESC, s.payment_route
$$;

GRANT EXECUTE ON FUNCTION public.tm_sales_daily(date, date) TO authenticated, service_role;