CREATE TABLE public.source_map (
  raw text PRIMARY KEY,
  code text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('performance','podcast','organic','affiliate','unknown')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.source_map TO authenticated;
GRANT ALL ON public.source_map TO service_role;
ALTER TABLE public.source_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read source_map" ON public.source_map FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can edit source_map" ON public.source_map FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can add source_map" ON public.source_map FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Service role manages source_map" ON public.source_map FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.source_map (raw, code, channel) VALUES
  ('Sabhi Digital','SD','performance'),
  ('Sabhi digital','SD','performance'),
  ('ScaleX','SX','performance'),
  ('SX','SX','performance'),
  ('Rajdeep','RJ','performance'),
  ('Gunjan','POD','podcast'),
  ('Bhanu','POD','podcast'),
  ('Dr. Shikha','POD','podcast'),
  ('TEDEQH','POD','podcast'),
  ('BADRI','POD','podcast'),
  ('VLAD','POD','podcast'),
  ('TechnoFunda','POD','podcast'),
  ('Vikaas_Naagru','POD','podcast'),
  ('Organic','ORG','organic'),
  ('Youtube Organic','ORG','organic'),
  ('Lead Magnet 3 Day Self Talk','LM','organic'),
  ('','UNASSIGNED','unknown');

CREATE TABLE public.ledger_inflow (
  row_hash text PRIMARY KEY,
  payment_date date,
  business_date date,
  payer_name text,
  email_raw text,
  email_key text,
  source_of_student_raw text,
  source_code text,
  product_raw text,
  product_tier text,
  amount_received numeric NOT NULL DEFAULT 0,
  amount_pending numeric,
  receipt_source text,
  payment_type text,
  sale_type text,
  is_new_sale boolean NOT NULL DEFAULT false,
  sheet_row integer,
  imported_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.ledger_inflow TO authenticated;
GRANT ALL ON public.ledger_inflow TO service_role;
ALTER TABLE public.ledger_inflow ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read ledger_inflow" ON public.ledger_inflow FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages ledger_inflow" ON public.ledger_inflow FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX ledger_inflow_bd_idx ON public.ledger_inflow (business_date);
CREATE INDEX ledger_inflow_tier_idx ON public.ledger_inflow (product_tier, business_date);
CREATE INDEX ledger_inflow_source_idx ON public.ledger_inflow (source_code);
CREATE INDEX ledger_inflow_email_idx ON public.ledger_inflow (email_key);

CREATE OR REPLACE FUNCTION public.upsert_ledger_inflow(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
    SELECT i.*, coalesce(m.code, 'UNASSIGNED') AS source_code
    FROM incoming i
    LEFT JOIN public.source_map m ON m.raw = btrim(i.source_of_student_raw)
    WHERE i.rn = 1
  ), upserted AS (
    INSERT INTO public.ledger_inflow (
      row_hash, payment_date, business_date, payer_name, email_raw, email_key,
      source_of_student_raw, source_code, product_raw, product_tier,
      amount_received, amount_pending, receipt_source, payment_type, sale_type,
      is_new_sale, sheet_row, imported_at)
    SELECT
      row_hash, payment_date,
      CASE WHEN payment_date IS NULL THEN NULL ELSE payment_date END,
      payer_name, email_raw, nullif(email_key,''),
      source_of_student_raw, source_code, product_raw, product_tier,
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
      source_code = excluded.source_code,
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
$$;
REVOKE EXECUTE ON FUNCTION public.upsert_ledger_inflow(jsonb) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.upsert_ledger_inflow(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.reapply_source_map()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.ledger_inflow l
  SET source_code = coalesce(m.code, 'UNASSIGNED')
  FROM (SELECT raw, code FROM public.source_map) m
  WHERE m.raw = btrim(l.source_of_student_raw)
    AND l.source_code IS DISTINCT FROM m.code;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.reapply_source_map() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.reapply_source_map() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ledger_daily(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER')
RETURNS TABLE(business_date date, sales bigint, collected numeric, pending numeric, rows_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT l.business_date,
         coalesce(sum(CASE WHEN l.is_new_sale THEN 1 ELSE 0 END),0)::bigint,
         coalesce(sum(l.amount_received),0)::numeric,
         coalesce(sum(l.amount_pending),0)::numeric,
         count(*)::bigint
  FROM public.ledger_inflow l
  WHERE l.business_date BETWEEN p_start AND p_end
    AND (p_tier IS NULL OR l.product_tier = p_tier)
  GROUP BY l.business_date
  ORDER BY l.business_date DESC
$$;
REVOKE EXECUTE ON FUNCTION public.ledger_daily(date,date,text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ledger_daily(date,date,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ledger_monthly(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER')
RETURNS TABLE(period text, sales bigint, collected numeric, buyers bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT to_char(l.business_date,'YYYY-MM'),
         coalesce(sum(CASE WHEN l.is_new_sale THEN 1 ELSE 0 END),0)::bigint,
         coalesce(sum(l.amount_received),0)::numeric,
         count(DISTINCT l.email_key)::bigint
  FROM public.ledger_inflow l
  WHERE l.business_date BETWEEN p_start AND p_end
    AND (p_tier IS NULL OR l.product_tier = p_tier)
  GROUP BY 1 ORDER BY 1
$$;
REVOKE EXECUTE ON FUNCTION public.ledger_monthly(date,date,text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ledger_monthly(date,date,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ledger_source_rollup(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER')
RETURNS TABLE(source_code text, channel text, sales bigint, collected numeric, rows_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT l.source_code,
         coalesce(max(m.channel), 'unknown'),
         coalesce(sum(CASE WHEN l.is_new_sale THEN 1 ELSE 0 END),0)::bigint,
         coalesce(sum(l.amount_received),0)::numeric,
         count(*)::bigint
  FROM public.ledger_inflow l
  LEFT JOIN public.source_map m ON m.code = l.source_code
  WHERE l.business_date BETWEEN p_start AND p_end
    AND (p_tier IS NULL OR l.product_tier = p_tier)
  GROUP BY l.source_code
  ORDER BY 3 DESC
$$;
REVOKE EXECUTE ON FUNCTION public.ledger_source_rollup(date,date,text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ledger_source_rollup(date,date,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ledger_rail_rollup(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER')
RETURNS TABLE(receipt_source text, rows_count bigint, collected numeric, share_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  WITH t AS (
    SELECT coalesce(l.receipt_source,'(unrecorded)') AS rail, count(*) AS n, sum(l.amount_received) AS amt
    FROM public.ledger_inflow l
    WHERE l.business_date BETWEEN p_start AND p_end
      AND (p_tier IS NULL OR l.product_tier = p_tier)
    GROUP BY 1
  )
  SELECT rail, n::bigint, coalesce(amt,0)::numeric,
         round(100.0 * n / nullif(sum(n) OVER (),0), 1)
  FROM t ORDER BY n DESC
$$;
REVOKE EXECUTE ON FUNCTION public.ledger_rail_rollup(date,date,text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ledger_rail_rollup(date,date,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ledger_unassigned_queue(p_start date, p_end date, p_limit integer DEFAULT 500)
RETURNS TABLE(row_hash text, business_date date, payer_name text, email_raw text, product_raw text, amount_received numeric, receipt_source text, is_new_sale boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT l.row_hash, l.business_date, l.payer_name, l.email_raw, l.product_raw,
         l.amount_received, l.receipt_source, l.is_new_sale
  FROM public.ledger_inflow l
  WHERE l.source_code = 'UNASSIGNED'
    AND l.business_date BETWEEN p_start AND p_end
  ORDER BY l.is_new_sale DESC, l.amount_received DESC
  LIMIT greatest(1, least(p_limit, 5000))
$$;
REVOKE EXECUTE ON FUNCTION public.ledger_unassigned_queue(date,date,integer) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.ledger_unassigned_queue(date,date,integer) TO authenticated, service_role;