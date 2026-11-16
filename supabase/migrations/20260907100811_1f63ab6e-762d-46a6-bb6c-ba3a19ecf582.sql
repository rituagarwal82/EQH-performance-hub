
-- ============ E1: permanent invariant that every public view is security_invoker ============
CREATE OR REPLACE FUNCTION public.inv_view_security_invoker_rows()
RETURNS TABLE(check_id text, checked_at timestamptz, for_date date, primary_value numeric,
              primary_source text, witness_value numeric, witness_source text,
              divergence_pct numeric, verdict text, note text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    'inv_view_security_invoker'::text,
    now(),
    current_date,
    0::numeric,
    'view definition'::text,
    1::numeric,
    'required setting'::text,
    NULL::numeric,
    'diverged'::text,
    format('View %I runs with owner privileges, so row-level permissions do not apply to it. Set security_invoker on.', c.relname)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'v'
    AND NOT coalesce((
      SELECT option_value = 'true'
      FROM pg_options_to_table(c.reloptions)
      WHERE option_name = 'security_invoker'
    ), false)
$$;

GRANT EXECUTE ON FUNCTION public.inv_view_security_invoker_rows() TO authenticated, service_role;

INSERT INTO public.proof_registry (check_id, family, label, plain, expected_noise, fp_budget_per_30d, structural_note, enabled, ord)
VALUES (
  'inv_view_security_invoker', 'invariant',
  'Shared views respect permissions',
  'Every shared view in the database must obey the same row permissions as the tables beneath it. A view created without that setting hands out data the underlying table refuses.',
  'none — this must always be zero', 0,
  'Structural. A single row here means data is readable by anyone holding the key that ships in the web page.',
  true, 95)
ON CONFLICT (check_id) DO UPDATE SET
  label = excluded.label, plain = excluded.plain, enabled = true, updated_at = now();

-- ============ E3: staged, checked, atomic ledger rebuild ============
CREATE TABLE IF NOT EXISTS public.ledger_inflow_staging (LIKE public.ledger_inflow INCLUDING DEFAULTS);
ALTER TABLE public.ledger_inflow_staging ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.ledger_inflow_staging TO service_role;

DROP POLICY IF EXISTS "staging is service-role only" ON public.ledger_inflow_staging;
CREATE POLICY "staging is service-role only" ON public.ledger_inflow_staging
  FOR SELECT TO authenticated USING (false);

-- Clears the holding area at the start of a full re-import. The live table is untouched.
CREATE OR REPLACE FUNCTION public.begin_ledger_rebuild()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.ledger_inflow_staging;
END;
$$;
REVOKE ALL ON FUNCTION public.begin_ledger_rebuild() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_ledger_rebuild() TO service_role;

-- Writes a chunk of freshly read sheet rows into the holding area only.
CREATE OR REPLACE FUNCTION public.stage_ledger_inflow(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    SELECT i.* FROM incoming i WHERE i.rn = 1
  ), ins AS (
    INSERT INTO public.ledger_inflow_staging (
      row_hash, payment_date, business_date, payer_name, email_raw, email_key,
      source_of_student_raw, product_raw, product_tier,
      amount_received, amount_pending, receipt_source, payment_type, sale_type,
      is_new_sale, sheet_row, imported_at)
    SELECT
      row_hash, payment_date, payment_date, payer_name, email_raw, nullif(email_key,''),
      source_of_student_raw, product_raw, product_tier,
      amount_received, amount_pending, receipt_source, payment_type, sale_type,
      is_new_sale, sheet_row, now()
    FROM resolved
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.stage_ledger_inflow(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stage_ledger_inflow(jsonb) TO service_role;

-- Swaps the holding area into the live table in ONE transaction, and refuses a
-- swap that would lose more than 3% of rows or 3% of money unless overridden.
CREATE OR REPLACE FUNCTION public.commit_ledger_rebuild(p_allow_shrink boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live_rows bigint; v_new_rows bigint;
  v_live_amt numeric; v_new_amt numeric;
BEGIN
  SELECT count(*), coalesce(sum(amount_received),0) INTO v_live_rows, v_live_amt FROM public.ledger_inflow;
  SELECT count(*), coalesce(sum(amount_received),0) INTO v_new_rows, v_new_amt FROM public.ledger_inflow_staging;

  IF v_new_rows = 0 THEN
    RAISE EXCEPTION 'Refusing to replace the ledger with an empty import (live has % rows).', v_live_rows;
  END IF;

  IF NOT p_allow_shrink AND v_live_rows > 0 THEN
    IF v_new_rows < v_live_rows * 0.97 THEN
      RAISE EXCEPTION 'Refusing the swap: the new import has % rows against % live (a drop of more than 3%%).', v_new_rows, v_live_rows;
    END IF;
    IF v_live_amt > 0 AND v_new_amt < v_live_amt * 0.97 THEN
      RAISE EXCEPTION 'Refusing the swap: the new import totals % against % live (a drop of more than 3%%).', v_new_amt, v_live_amt;
    END IF;
  END IF;

  DELETE FROM public.ledger_inflow;
  INSERT INTO public.ledger_inflow SELECT * FROM public.ledger_inflow_staging;
  DELETE FROM public.ledger_inflow_staging;

  PERFORM public.recompute_seat_sales();

  RETURN jsonb_build_object(
    'previous_rows', v_live_rows, 'new_rows', v_new_rows,
    'previous_amount', v_live_amt, 'new_amount', v_new_amt);
END;
$$;
REVOKE ALL ON FUNCTION public.commit_ledger_rebuild(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_ledger_rebuild(boolean) TO service_role;

-- ============ E2: a real scheduled backup ============
CREATE TABLE IF NOT EXISTS public.ledger_inflow_snapshots (
  snapshot_at date NOT NULL,
  row_hash text NOT NULL,
  payment_date date,
  business_date date,
  payer_name text,
  email_raw text,
  email_key text,
  source_of_student_raw text,
  product_raw text,
  product_tier text,
  amount_received numeric NOT NULL DEFAULT 0,
  amount_pending numeric,
  receipt_source text,
  payment_type text,
  sale_type text,
  is_new_sale boolean NOT NULL DEFAULT false,
  sheet_row integer,
  PRIMARY KEY (snapshot_at, row_hash)
);
GRANT SELECT ON public.ledger_inflow_snapshots TO authenticated;
GRANT ALL ON public.ledger_inflow_snapshots TO service_role;
ALTER TABLE public.ledger_inflow_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "signed-in users can read ledger backups" ON public.ledger_inflow_snapshots;
CREATE POLICY "signed-in users can read ledger backups" ON public.ledger_inflow_snapshots
  FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.snapshot_ledger_inflow()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rows bigint;
BEGIN
  DELETE FROM public.ledger_inflow_snapshots WHERE snapshot_at = current_date;
  INSERT INTO public.ledger_inflow_snapshots (
    snapshot_at, row_hash, payment_date, business_date, payer_name, email_raw, email_key,
    source_of_student_raw, product_raw, product_tier, amount_received, amount_pending,
    receipt_source, payment_type, sale_type, is_new_sale, sheet_row)
  SELECT current_date, row_hash, payment_date, business_date, payer_name, email_raw, email_key,
    source_of_student_raw, product_raw, product_tier, amount_received, amount_pending,
    receipt_source, payment_type, sale_type, is_new_sale, sheet_row
  FROM public.ledger_inflow;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  DELETE FROM public.ledger_inflow_snapshots WHERE snapshot_at < current_date - 30;
  RETURN jsonb_build_object('snapshot_at', current_date, 'rows', v_rows);
END;
$$;
REVOKE ALL ON FUNCTION public.snapshot_ledger_inflow() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_ledger_inflow() TO service_role;

SELECT cron.schedule('snapshot-ledger', '30 20 * * *', $$SELECT public.snapshot_ledger_inflow();$$);

-- Seed today's snapshot from the hand-made backup so cover exists immediately.
INSERT INTO public.ledger_inflow_snapshots (
  snapshot_at, row_hash, payment_date, business_date, payer_name, email_raw, email_key,
  source_of_student_raw, product_raw, product_tier, amount_received, amount_pending,
  receipt_source, payment_type, sale_type, is_new_sale, sheet_row)
SELECT current_date, row_hash, payment_date, business_date, payer_name, email_raw, email_key,
  source_of_student_raw, product_raw, product_tier, amount_received, amount_pending,
  receipt_source, payment_type, sale_type, is_new_sale, sheet_row
FROM public.ledger_inflow
ON CONFLICT DO NOTHING;

-- ============ E11: scope the team-change log ============
DROP POLICY IF EXISTS "regime_events readable" ON public.regime_events;
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='regime_events' AND cmd='SELECT'
  LOOP EXECUTE format('DROP POLICY %I ON public.regime_events', p.policyname); END LOOP;
END $$;
REVOKE SELECT ON public.regime_events FROM anon;
CREATE POLICY "signed-in users can read team changes" ON public.regime_events
  FOR SELECT TO authenticated USING (true);
