-- A sale under a live offer is fully paid at the OFFER price, not at the list
-- price. Judging every buyer against a fixed Rs 6,990 marked genuine, fully
-- paid coupon buyers as short, and it valued them at a price they never paid.
CREATE OR REPLACE FUNCTION public.rebuild_tm_sales()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('rebuild_tm_sales'));

  CREATE TEMP TABLE _tm_sales_next ON COMMIT DROP AS
  WITH enrolled AS (
    SELECT
      e.person_key, e.subscription_id, e.mango_id, pr.payment_route,
      e.enrolled_at, e.amount_via_tagmango, e.coupon_code, e.is_coupon
    FROM public.tm_enrolments e
    JOIN public.products pr ON pr.mango_id = e.mango_id
    WHERE pr.tier = 'L1_SILVER' AND pr.counts_as_sale
      AND e.person_key <> '' AND e.enrolled_at IS NOT NULL
  ), ordered AS (
    SELECT x.*, lag(x.enrolled_at) OVER (PARTITION BY x.person_key ORDER BY x.enrolled_at) AS prev_at
    FROM enrolled x
  ), marked AS (
    SELECT o.*,
      sum(CASE WHEN o.prev_at IS NULL OR o.enrolled_at > o.prev_at + interval '120 days' THEN 1 ELSE 0 END)
        OVER (PARTITION BY o.person_key ORDER BY o.enrolled_at ROWS UNBOUNDED PRECEDING) AS cohort
    FROM ordered o
  ), grouped AS (
    SELECT
      person_key, cohort,
      min(enrolled_at) AS first_at,
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
    SELECT
      g.*,
      GREATEST(
        g.amount_via_tagmango,
        COALESCE((
          SELECT sum(COALESCE(p.amount_inr, p.amount_gross))
          FROM public.tm_payments p
          JOIN public.products pp ON pp.mango_id = p.mango_id
          WHERE lower(btrim(p.buyer_email)) = g.person_key
            AND pp.tier = 'L1_SILVER'
            AND lower(coalesce(p.status,'')) IN ('completed','captured','success','successful','paid','active')
            AND p.paid_at >= g.first_at - interval '7 days'
            AND p.paid_at <= g.first_at + interval '120 days'
        ), 0)
      ) AS tm_amount,
      (
        SELECT coalesce(p2.coupon_code, p2.raw->>'coupon')
        FROM public.tm_payments p2
        WHERE lower(btrim(p2.buyer_email)) = g.person_key
          AND coalesce(p2.coupon_code, p2.raw->>'coupon') IS NOT NULL
          AND coalesce(p2.amount_inr, p2.amount_gross) > 0
          AND p2.paid_at >= g.first_at - interval '7 days'
          AND p2.paid_at <= g.first_at + interval '120 days'
        ORDER BY p2.paid_at LIMIT 1
      ) AS payment_coupon
    FROM grouped g
  ), expected AS (
    -- What this buyer was supposed to pay: the offer price when a live offer
    -- code was used, otherwise the standing list price.
    SELECT pz.*,
      public.l1_expected_price(
        COALESCE(pz.payment_coupon, pz.coupon_code),
        public.business_date(pz.first_at)
      ) AS expected_price
    FROM priced pz
  )
  SELECT
    person_key,
    first_at AS first_payment_at,
    public.business_date(first_at) AS business_date,
    (CASE WHEN has_bms THEN 'BMS' WHEN has_emi THEN 'EMI' ELSE 'FULL' END)::text AS payment_route,
    tm_amount AS gross_collected,
    tm_amount AS amount_via_tagmango,
    NULL::numeric AS amount_via_ledger,
    (CASE WHEN tm_amount >= expected_price * 0.98 THEN 'TAGMANGO' ELSE 'UNRECONCILED' END)::text AS revenue_source,
    (CASE
      WHEN tm_amount >= expected_price * 0.98 THEN 'MATCHED'
      WHEN is_coupon OR coupon_code IS NOT NULL OR payment_coupon IS NOT NULL OR tm_amount = 0
        THEN 'AWAITING_LEDGER'
      ELSE 'SHORTFALL'
    END)::text AS revenue_status,
    (is_coupon OR coupon_code IS NOT NULL OR payment_coupon IS NOT NULL) AS is_coupon,
    COALESCE(payment_coupon, coupon_code) AS coupon_code,
    expected_price AS expected_gross,
    (tm_amount >= expected_price * 0.98) AS is_fully_paid,
    enrolment_count AS payment_count,
    enrolment_count,
    first_mango_id
  FROM expected;

  DELETE FROM public.tm_sales WHERE true;
  INSERT INTO public.tm_sales (
    person_key, first_payment_at, business_date, payment_route,
    gross_collected, amount_via_tagmango, amount_via_ledger, revenue_source, revenue_status,
    is_coupon, coupon_code, expected_gross, is_fully_paid, payment_count, enrolment_count,
    first_mango_id, updated_at)
  SELECT person_key, first_payment_at, business_date, payment_route,
    gross_collected, amount_via_tagmango, amount_via_ledger, revenue_source, revenue_status,
    is_coupon, coupon_code, expected_gross, is_fully_paid, payment_count, enrolment_count,
    first_mango_id, now()
  FROM _tm_sales_next;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;