CREATE OR REPLACE FUNCTION public.recompute_seat_sales()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare v_dep int; v_comp int;
begin
  UPDATE public.ledger_inflow
     SET is_seat_deposit = (product_tier = 'L1_SILVER' AND payment_type = 'Booking Amount')
   WHERE is_seat_deposit <> (product_tier = 'L1_SILVER' AND payment_type = 'Booking Amount');

  UPDATE public.ledger_inflow
     SET seat_completed_at = NULL, seat_completion_of = NULL
   WHERE seat_completed_at IS NOT NULL OR seat_completion_of IS NOT NULL;

  WITH dep AS (
    SELECT row_hash, email_key, business_date,
           row_number() OVER (PARTITION BY email_key ORDER BY business_date, row_hash) AS rn
      FROM public.ledger_inflow
     WHERE is_seat_deposit AND email_key IS NOT NULL
  ), bal AS (
    SELECT row_hash, email_key, business_date,
           row_number() OVER (PARTITION BY email_key ORDER BY business_date, row_hash) AS rn
      FROM public.ledger_inflow
     WHERE product_tier = 'L1_SILVER' AND NOT is_seat_deposit AND email_key IS NOT NULL
       AND payment_type IN ('Final Payment','Full Payment','Instalment')
  ), pair AS (
    SELECT d.row_hash AS dep_hash, b.row_hash AS bal_hash, b.business_date AS completed_at
      FROM dep d
      JOIN bal b ON b.email_key = d.email_key AND b.rn = d.rn
     WHERE b.business_date >= d.business_date
  ), u1 AS (
    UPDATE public.ledger_inflow l SET seat_completed_at = p.completed_at
      FROM pair p WHERE l.row_hash = p.dep_hash RETURNING 1
  ), u2 AS (
    UPDATE public.ledger_inflow l SET seat_completion_of = p.dep_hash
      FROM pair p WHERE l.row_hash = p.bal_hash RETURNING 1
  )
  SELECT (SELECT count(*) FROM u1), (SELECT count(*) FROM u2) INTO v_dep, v_comp;

  UPDATE public.ledger_inflow l
     SET counts_as_sale = CASE
           WHEN l.is_seat_deposit THEN false
           WHEN l.seat_completion_of IS NOT NULL THEN true
           ELSE l.is_new_sale END,
         revenue_recognized = CASE
           WHEN l.is_seat_deposit THEN l.seat_completed_at IS NOT NULL
           WHEN l.seat_completion_of IS NOT NULL THEN true
           ELSE l.is_new_sale END;

  return jsonb_build_object('deposits_completed', v_dep, 'completion_rows', v_comp,
    'deposits_total', (select count(*) from public.ledger_inflow where is_seat_deposit),
    'sales_total', (select count(*) from public.ledger_inflow where counts_as_sale));
end $function$;