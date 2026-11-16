CREATE OR REPLACE FUNCTION public.rebuild_tm_sales()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM public.tm_sales WHERE true;

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

REVOKE ALL ON FUNCTION public.rebuild_tm_sales() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_tm_sales() TO service_role;