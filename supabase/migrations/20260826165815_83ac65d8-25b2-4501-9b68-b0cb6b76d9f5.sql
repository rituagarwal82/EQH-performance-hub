CREATE OR REPLACE FUNCTION public.upsert_ledger_inflow(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  WITH incoming AS (
    SELECT
      r->>'row_hash' AS row_hash,
      nullif(r->>'payment_date','')::date AS payment_date,
      nullif(r->>'payer_name','') AS payer_name,
      nullif(r->>'email_raw','') AS email_raw,
      lower(btrim(coalesce(r->>'email_raw',''))) AS email_key,
      coalesce(r->>'source_of_student_raw','') AS source_of_student_raw,
      nullif(r->>'product_raw','') AS product_raw,
      nullif(r->>'product_tier','') AS product_tier,
      coalesce((r->>'amount_received')::numeric, 0) AS amount_received,
      nullif(r->>'amount_pending','')::numeric AS amount_pending,
      nullif(r->>'receipt_source','') AS receipt_source,
      nullif(r->>'payment_type','') AS payment_type,
      nullif(r->>'sale_type','') AS sale_type,
      coalesce((r->>'is_new_sale')::boolean, false) AS is_new_sale,
      nullif(r->>'sheet_row','')::int AS sheet_row,
      row_number() OVER (PARTITION BY r->>'row_hash' ORDER BY r->>'sheet_row') AS rn
    FROM jsonb_array_elements(p_rows) AS r
  ), resolved AS (
    SELECT i.* FROM incoming i WHERE i.rn = 1
  ), upserted AS (
    INSERT INTO public.ledger_inflow (
      row_hash, payment_date, business_date, payer_name, email_raw, email_key,
      source_of_student_raw, product_raw, product_tier,
      amount_received, amount_pending, receipt_source, payment_type, sale_type,
      is_new_sale, sheet_row, imported_at)
    SELECT
      row_hash, payment_date, payment_date,
      payer_name, email_raw, nullif(email_key,''),
      source_of_student_raw, product_raw, product_tier,
      amount_received, amount_pending, receipt_source, payment_type, sale_type,
      is_new_sale, sheet_row, now()
    FROM resolved
    ON CONFLICT (row_hash) DO UPDATE SET
      payment_date = excluded.payment_date,
      business_date = excluded.business_date,
      payer_name = excluded.payer_name,
      email_raw = excluded.email_raw,
      email_key = excluded.email_key,
      source_of_student_raw = excluded.source_of_student_raw,
      product_raw = excluded.product_raw,
      product_tier = excluded.product_tier,
      amount_received = excluded.amount_received,
      amount_pending = excluded.amount_pending,
      receipt_source = excluded.receipt_source,
      payment_type = excluded.payment_type,
      sale_type = excluded.sale_type,
      is_new_sale = excluded.is_new_sale,
      sheet_row = excluded.sheet_row,
      imported_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.upsert_ledger_inflow(jsonb) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.upsert_ledger_inflow(jsonb) TO service_role, authenticated;