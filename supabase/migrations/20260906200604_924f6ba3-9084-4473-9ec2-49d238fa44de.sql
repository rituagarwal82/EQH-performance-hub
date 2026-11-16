-- Owner decision 2026-09-06: a Book My Seat deposit is not an L1 sale.
-- The sale is recognised only when the balance completes, dated at the completion payment.
ALTER TABLE public.ledger_inflow
  ADD COLUMN IF NOT EXISTS is_seat_deposit boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS seat_completed_at date,
  ADD COLUMN IF NOT EXISTS seat_completion_of text,
  ADD COLUMN IF NOT EXISTS counts_as_sale boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS revenue_recognized boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS ledger_inflow_counts_as_sale_idx ON public.ledger_inflow (business_date) WHERE counts_as_sale;
CREATE INDEX IF NOT EXISTS ledger_inflow_seat_deposit_idx ON public.ledger_inflow (business_date) WHERE is_seat_deposit;

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

  UPDATE public.ledger_inflow
     SET counts_as_sale = CASE
           WHEN is_seat_deposit THEN false
           WHEN seat_completion_of IS NOT NULL THEN true
           ELSE is_new_sale END,
         revenue_recognized = CASE
           WHEN is_seat_deposit THEN seat_completed_at IS NOT NULL
           WHEN seat_completion_of IS NOT NULL THEN true
           ELSE is_new_sale END;

  return jsonb_build_object('deposits_completed', v_dep, 'completion_rows', v_comp,
    'deposits_total', (select count(*) from public.ledger_inflow where is_seat_deposit),
    'sales_total', (select count(*) from public.ledger_inflow where counts_as_sale));
end $function$;

CREATE OR REPLACE FUNCTION public.held_seats(p_start date, p_end date)
RETURNS TABLE(held bigint, deposits_received numeric, balance_outstanding numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT count(*)::bigint,
         coalesce(sum(l.amount_received),0)::numeric,
         coalesce(sum(l.amount_pending),0)::numeric
    FROM public.ledger_inflow l
   WHERE l.is_seat_deposit AND l.seat_completed_at IS NULL
     AND l.business_date BETWEEN p_start AND p_end
$function$;

CREATE OR REPLACE FUNCTION public.seat_completion_stats(p_start date, p_end date)
RETURNS TABLE(bookings bigint, completed bigint, completion_rate numeric, median_days numeric,
              deposits_received numeric, balance_outstanding numeric, held bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT count(*)::bigint,
         count(*) FILTER (WHERE l.seat_completed_at IS NOT NULL)::bigint,
         CASE WHEN count(*) > 0
              THEN round(100.0 * count(*) FILTER (WHERE l.seat_completed_at IS NOT NULL) / count(*), 1) END,
         (percentile_cont(0.5) WITHIN GROUP (
           ORDER BY (l.seat_completed_at - l.business_date))
           FILTER (WHERE l.seat_completed_at IS NOT NULL))::numeric,
         coalesce(sum(l.amount_received),0)::numeric,
         coalesce(sum(l.amount_pending) FILTER (WHERE l.seat_completed_at IS NULL),0)::numeric,
         count(*) FILTER (WHERE l.seat_completed_at IS NULL)::bigint
    FROM public.ledger_inflow l
   WHERE l.is_seat_deposit AND l.business_date BETWEEN p_start AND p_end
$function$;