ALTER TABLE public.tm_payments ADD COLUMN IF NOT EXISTS affiliate_user text, ADD COLUMN IF NOT EXISTS affiliate_commission numeric;
ALTER TABLE public.tm_enrolments ADD COLUMN IF NOT EXISTS affiliate_user text;
COMMENT ON COLUMN public.tm_payments.affiliate_user IS 'TagMango order.affiliateUser (id of the referring affiliate), promoted from raw.';
COMMENT ON COLUMN public.tm_payments.affiliate_commission IS 'TagMango order.affiliateComission (spelling as TagMango sends it).';

UPDATE public.tm_payments SET
  affiliate_user = nullif(coalesce(raw->'affiliateUser'->>'_id', raw->>'affiliateUser'),''),
  affiliate_commission = CASE WHEN jsonb_typeof(raw->'affiliateComission')='number' THEN (raw->>'affiliateComission')::numeric END
WHERE raw IS NOT NULL;

CREATE OR REPLACE FUNCTION public.upsert_tm_enrolments(p_rows jsonb)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  WITH upserted AS (
    INSERT INTO public.tm_enrolments (
      subscription_id, person_key, buyer_email, buyer_phone, mango_id, enrolled_at,
      business_date, status, amount_via_tagmango, coupon_code, is_coupon, affiliate_user, raw, synced_at)
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
      nullif(r->>'affiliate_user',''),
      r->'raw',
      now()
    FROM jsonb_array_elements(p_rows) AS r
    WHERE btrim(coalesce(r->>'buyer_email','')) <> ''
    ON CONFLICT (subscription_id) DO UPDATE SET
      person_key = excluded.person_key, buyer_email = excluded.buyer_email,
      buyer_phone = excluded.buyer_phone, mango_id = excluded.mango_id,
      enrolled_at = excluded.enrolled_at, business_date = excluded.business_date,
      status = excluded.status, amount_via_tagmango = excluded.amount_via_tagmango,
      coupon_code = excluded.coupon_code, is_coupon = excluded.is_coupon,
      affiliate_user = excluded.affiliate_user,
      raw = excluded.raw, synced_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.upsert_tm_payments(p_rows jsonb)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  WITH upserted AS (
    INSERT INTO public.tm_payments (
      payment_id, mango_id, buyer_email, buyer_phone, amount_gross, amount_net,
      currency, status, paid_at, business_date, raw, synced_at,
      amount_inr, list_price_inr, discount_inr, coupon_code, exchange_rate, sale_status, fx_basis,
      affiliate_user, affiliate_commission)
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
      public.tm_order_fx_basis(r->'raw'),
      nullif(coalesce(r->'raw'->'affiliateUser'->>'_id', r->'raw'->>'affiliateUser'),''),
      CASE WHEN jsonb_typeof(r->'raw'->'affiliateComission')='number' THEN (r->'raw'->>'affiliateComission')::numeric END
    FROM jsonb_array_elements(p_rows) AS r
    ON CONFLICT (payment_id) DO UPDATE SET
      mango_id = excluded.mango_id, buyer_email = excluded.buyer_email,
      buyer_phone = excluded.buyer_phone, amount_gross = excluded.amount_gross,
      amount_net = excluded.amount_net, currency = excluded.currency,
      status = excluded.status, paid_at = excluded.paid_at,
      business_date = excluded.business_date, raw = excluded.raw, synced_at = now(),
      amount_inr = excluded.amount_inr, list_price_inr = excluded.list_price_inr,
      discount_inr = excluded.discount_inr, coupon_code = excluded.coupon_code,
      exchange_rate = excluded.exchange_rate, sale_status = excluded.sale_status,
      fx_basis = excluded.fx_basis,
      affiliate_user = excluded.affiliate_user, affiliate_commission = excluded.affiliate_commission
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$function$;