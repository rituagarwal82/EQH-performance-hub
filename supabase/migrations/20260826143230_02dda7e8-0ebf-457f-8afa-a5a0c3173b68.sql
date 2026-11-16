-- 1. Enrolments: the entitlement record. A sale is an enrolment, not a payment.
CREATE TABLE IF NOT EXISTS public.tm_enrolments (
  subscription_id text PRIMARY KEY,
  person_key text NOT NULL,
  buyer_email text,
  buyer_phone text,
  mango_id text REFERENCES public.products(mango_id),
  enrolled_at timestamptz,
  business_date date,
  status text,
  amount_via_tagmango numeric(12,2) NOT NULL DEFAULT 0,
  coupon_code text,
  is_coupon boolean NOT NULL DEFAULT false,
  raw jsonb,
  synced_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.tm_enrolments TO authenticated;
GRANT ALL ON public.tm_enrolments TO service_role;
ALTER TABLE public.tm_enrolments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read tm_enrolments" ON public.tm_enrolments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages tm_enrolments" ON public.tm_enrolments FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS tm_enrolments_person_idx ON public.tm_enrolments (person_key, enrolled_at);
CREATE INDEX IF NOT EXISTS tm_enrolments_business_date_idx ON public.tm_enrolments (business_date);

-- 2. Sales gain the money-separation columns.
ALTER TABLE public.tm_sales
  ADD COLUMN IF NOT EXISTS amount_via_tagmango numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS amount_via_ledger numeric(12,2),
  ADD COLUMN IF NOT EXISTS revenue_source text,
  ADD COLUMN IF NOT EXISTS revenue_status text,
  ADD COLUMN IF NOT EXISTS is_coupon boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS coupon_code text,
  ADD COLUMN IF NOT EXISTS enrolment_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS tm_sales_revenue_status_idx ON public.tm_sales (revenue_status);

CREATE OR REPLACE FUNCTION public.upsert_tm_enrolments(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count integer;
BEGIN
  WITH upserted AS (
    INSERT INTO public.tm_enrolments (
      subscription_id, person_key, buyer_email, buyer_phone, mango_id, enrolled_at,
      business_date, status, amount_via_tagmango, coupon_code, is_coupon, raw, synced_at)
    SELECT
      r->>'subscription_id',
      lower(btrim(coalesce(r->>'buyer_email',''))),
      nullif(r->>'buyer_email',''),
      nullif(r->>'buyer_phone',''),
      nullif(r->>'mango_id',''),
      nullif(r->>'enrolled_at','')::timestamptz,
      public.business_date(nullif(r->>'enrolled_at','')::timestamptz),
      nullif(r->>'status',''),
      coalesce((r->>'amount_via_tagmango')::numeric, 0),
      nullif(r->>'coupon_code',''),
      coalesce((r->>'is_coupon')::boolean, false),
      r->'raw',
      now()
    FROM jsonb_array_elements(p_rows) AS r
    WHERE btrim(coalesce(r->>'buyer_email','')) <> ''
    ON CONFLICT (subscription_id) DO UPDATE SET
      person_key = excluded.person_key,
      buyer_email = excluded.buyer_email,
      buyer_phone = excluded.buyer_phone,
      mango_id = excluded.mango_id,
      enrolled_at = excluded.enrolled_at,
      business_date = excluded.business_date,
      status = excluded.status,
      amount_via_tagmango = excluded.amount_via_tagmango,
      coupon_code = excluded.coupon_code,
      is_coupon = excluded.is_coupon,
      raw = excluded.raw,
      synced_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_tm_enrolments(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_tm_enrolments(jsonb) TO service_role;

-- 3. Rebuild sales from ENROLMENTS. Money is a separate lookup, never a filter.
CREATE OR REPLACE FUNCTION public.rebuild_tm_sales()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM public.tm_sales WHERE true;

  WITH enrolled AS (
    SELECT
      e.person_key,
      e.subscription_id,
      e.mango_id,
      pr.payment_route,
      e.enrolled_at,
      e.amount_via_tagmango,
      e.coupon_code,
      e.is_coupon
    FROM public.tm_enrolments e
    JOIN public.products pr ON pr.mango_id = e.mango_id
    WHERE pr.tier = 'L1_SILVER'
      AND pr.counts_as_sale
      AND e.person_key <> ''
      AND e.enrolled_at IS NOT NULL
  ), ordered AS (
    SELECT x.*, lag(x.enrolled_at) OVER (PARTITION BY x.person_key ORDER BY x.enrolled_at) AS prev_at
    FROM enrolled x
  ), marked AS (
    -- An enrolment more than 120 days after the previous one is a new purchase.
    SELECT o.*,
      sum(CASE WHEN o.prev_at IS NULL OR o.enrolled_at > o.prev_at + interval '120 days' THEN 1 ELSE 0 END)
        OVER (PARTITION BY o.person_key ORDER BY o.enrolled_at ROWS UNBOUNDED PRECEDING) AS cohort
    FROM ordered o
  ), grouped AS (
    SELECT
      person_key,
      cohort,
      min(enrolled_at) AS first_at,
      max(enrolled_at) AS last_at,
      count(*) AS enrolment_count,
      sum(amount_via_tagmango) AS amount_via_tagmango,
      bool_or(is_coupon) AS is_coupon,
      (array_agg(coupon_code) FILTER (WHERE coupon_code IS NOT NULL))[1] AS coupon_code,
      bool_or(payment_route LIKE 'BMS%') AS has_bms,
      bool_or(payment_route = 'EMI') AS has_emi,
      (array_agg(mango_id ORDER BY enrolled_at))[1] AS first_mango_id
    FROM marked
    GROUP BY person_key, cohort
  ), priced AS (
    -- Payments captured in the same cohort window top up what TagMango charged
    -- (EMI instalments arrive after the enrolment record was written).
    SELECT
      g.*,
      GREATEST(
        g.amount_via_tagmango,
        COALESCE((
          SELECT sum(p.amount_gross)
          FROM public.tm_payments p
          JOIN public.products pp ON pp.mango_id = p.mango_id
          WHERE lower(btrim(p.buyer_email)) = g.person_key
            AND pp.tier = 'L1_SILVER' AND pp.counts_as_sale
            AND lower(coalesce(p.status,'')) IN ('completed','captured','success','successful','paid','active')
            AND p.paid_at >= g.first_at - interval '7 days'
            AND p.paid_at <= g.first_at + interval '120 days'
        ), 0)
      ) AS tm_amount,
      (
        SELECT (p2.raw->>'coupon')
        FROM public.tm_payments p2
        WHERE lower(btrim(p2.buyer_email)) = g.person_key
          AND p2.raw->>'coupon' IS NOT NULL
          AND p2.paid_at >= g.first_at - interval '7 days'
          AND p2.paid_at <= g.first_at + interval '120 days'
        ORDER BY p2.paid_at
        LIMIT 1
      ) AS payment_coupon
    FROM grouped g
  ), inserted AS (
    INSERT INTO public.tm_sales (
      person_key, first_payment_at, business_date, payment_route,
      gross_collected, amount_via_tagmango, amount_via_ledger, revenue_source, revenue_status,
      is_coupon, coupon_code, expected_gross, is_fully_paid, payment_count, enrolment_count,
      first_mango_id, updated_at)
    SELECT
      person_key,
      first_at,
      public.business_date(first_at),
      CASE WHEN has_bms THEN 'BMS' WHEN has_emi THEN 'EMI' ELSE 'FULL' END,
      tm_amount,
      tm_amount,
      NULL,
      CASE WHEN tm_amount >= 6900 THEN 'TAGMANGO' ELSE 'UNRECONCILED' END,
      CASE
        WHEN tm_amount >= 6900 THEN 'MATCHED'
        WHEN is_coupon OR coupon_code IS NOT NULL OR payment_coupon IS NOT NULL OR tm_amount = 0
          THEN 'AWAITING_LEDGER'
        ELSE 'SHORTFALL'
      END,
      (is_coupon OR coupon_code IS NOT NULL OR payment_coupon IS NOT NULL),
      COALESCE(coupon_code, payment_coupon),
      6990,
      tm_amount >= 6900,
      enrolment_count,
      enrolment_count,
      first_mango_id,
      now()
    FROM priced
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM inserted;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.rebuild_tm_sales() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_tm_sales() TO service_role;

-- 4. Daily rollup: sales count and located revenue are reported separately.
DROP FUNCTION IF EXISTS public.tm_sales_daily(date, date);
CREATE OR REPLACE FUNCTION public.tm_sales_daily(p_start date, p_end date)
RETURNS TABLE(
  business_date date,
  payment_route text,
  sales bigint,
  located_gross numeric,
  located_net numeric,
  awaiting_ledger bigint,
  awaiting_value numeric,
  shortfall bigint
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    s.business_date,
    s.payment_route,
    count(*)::bigint,
    sum(coalesce(s.amount_via_ledger, s.amount_via_tagmango))::numeric,
    round(sum(coalesce(s.amount_via_ledger, s.amount_via_tagmango)) / 1.18, 2)::numeric,
    count(*) FILTER (WHERE s.revenue_status = 'AWAITING_LEDGER')::bigint,
    (sum(s.expected_gross) FILTER (WHERE s.revenue_status = 'AWAITING_LEDGER'))::numeric,
    count(*) FILTER (WHERE s.revenue_status = 'SHORTFALL')::bigint
  FROM public.tm_sales s
  WHERE s.business_date >= p_start AND s.business_date <= p_end
  GROUP BY s.business_date, s.payment_route
  ORDER BY s.business_date DESC, s.payment_route
$$;

REVOKE ALL ON FUNCTION public.tm_sales_daily(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tm_sales_daily(date, date) TO authenticated, service_role;

-- 5. Manual reconciliation worklist.
CREATE OR REPLACE FUNCTION public.tm_reconciliation_queue(p_limit integer DEFAULT 500)
RETURNS TABLE(
  sale_id uuid,
  person_key text,
  business_date date,
  first_payment_at timestamptz,
  payment_route text,
  coupon_code text,
  amount_via_tagmango numeric,
  expected_gross numeric,
  gap numeric,
  revenue_status text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    s.sale_id, s.person_key, s.business_date, s.first_payment_at, s.payment_route,
    s.coupon_code, s.amount_via_tagmango, s.expected_gross,
    (s.expected_gross - coalesce(s.amount_via_ledger, s.amount_via_tagmango))::numeric,
    s.revenue_status
  FROM public.tm_sales s
  WHERE s.revenue_status IN ('AWAITING_LEDGER','SHORTFALL')
  ORDER BY s.business_date DESC NULLS LAST, s.person_key
  LIMIT greatest(1, least(p_limit, 5000))
$$;

REVOKE ALL ON FUNCTION public.tm_reconciliation_queue(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tm_reconciliation_queue(integer) TO authenticated, service_role;