CREATE TABLE public.agency_open_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_code text NOT NULL,
  ord int NOT NULL,
  raised_on date NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  answered_note text,
  answered_on date,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.agency_open_items TO authenticated;
GRANT ALL ON public.agency_open_items TO service_role;
ALTER TABLE public.agency_open_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read agency items" ON public.agency_open_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth edit agency items" ON public.agency_open_items FOR UPDATE TO authenticated USING (true);
CREATE POLICY "auth add agency items" ON public.agency_open_items FOR INSERT TO authenticated WITH CHECK (true);

CREATE TABLE public.agency_email_log (
  kind text NOT NULL,
  period_key text NOT NULL,
  status text NOT NULL,
  subject text,
  body_text text,
  recipients text[],
  message_id text,
  last_error text,
  refusals jsonb,
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, period_key)
);
GRANT SELECT ON public.agency_email_log TO authenticated;
GRANT ALL ON public.agency_email_log TO service_role;
ALTER TABLE public.agency_email_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth read agency log" ON public.agency_email_log FOR SELECT TO authenticated USING (true);

-- Sabhi's accounts, by number. Excluded accounts are never read.
CREATE OR REPLACE FUNCTION public.sabhi_bucket_of_account(p_account text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE replace(coalesce(p_account,''),'act_','')
    WHEN '1249430309131428' THEN '1249430309131428'
    WHEN '1109475161619539' THEN '1109475161619539'
    WHEN '1488704194840585' THEN '1488704194840585'
    WHEN '587640350334915' THEN 'excluded'
    WHEN '699110549552181' THEN 'excluded'
    ELSE NULL END
$$;

-- First registrations through Sabhi, account taken from the advertisement.
CREATE OR REPLACE FUNCTION public.sabhi_first_regs(p_start date, p_end date)
RETURNS TABLE(email_key text, reg_date date, bucket text, ad_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH fa AS (
    SELECT a.email_key, a.captured_at, a.ad_id,
           (a.captured_at AT TIME ZONE 'Asia/Kolkata' - interval '6 hours')::date AS d
    FROM lead_attribution_mv a
    WHERE (a.captured_at AT TIME ZONE 'Asia/Kolkata' - interval '6 hours')::date BETWEEN p_start AND p_end
  )
  SELECT fa.email_key, fa.d, sabhi_bucket_of_account(ae.account_id), fa.ad_id
  FROM fa JOIN ad_entities ae ON ae.entity_id = fa.ad_id AND ae.level = 'ad'
  WHERE sabhi_bucket_of_account(ae.account_id) IN ('1249430309131428','1109475161619539','1488704194840585')
  UNION ALL
  SELECT DISTINCT ON (fa.email_key) fa.email_key, fa.d, 'google', NULL
  FROM fa JOIN leads l ON l.email_key = fa.email_key AND l.captured_at = fa.captured_at
  JOIN lead_unified_source u ON u.lead_id = l.lead_id
  WHERE u.unified_channel ILIKE 'Sabhi%Google%'
    AND NOT EXISTS (SELECT 1 FROM ad_entities ae2 WHERE ae2.entity_id = fa.ad_id);
$$;

-- Sabhi sales in a window (by the accounts sheet's date), one row per buyer per day.
CREATE OR REPLACE FUNCTION public.sabhi_sales(p_start date, p_end date)
RETURNS TABLE(business_date date, email_key text, cash numeric, bucket text, ad_id text, first_reg date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH days AS (SELECT generate_series(p_start, p_end, interval '1 day')::date d),
  s AS (
    SELECT DISTINCT li.business_date, coalesce(nullif(li.email_key,''),'name:'||lower(li.payer_name)) k, sa.channel
    FROM ledger_inflow li JOIN sale_attribution sa ON sa.row_hash = li.row_hash
    WHERE li.business_date BETWEEN p_start AND p_end AND li.product_tier='L1_SILVER'
      AND li.is_new_sale AND li.counts_as_sale AND sa.channel ILIKE 'Sabhi%'
  ),
  c AS (
    SELECT days.d, g.email_key k, sum(g.amount * g.counted) cash
    FROM days CROSS JOIN LATERAL daily_sale_amount_groups(days.d) g GROUP BY 1,2
  ),
  fa AS (
    SELECT a.email_key, a.ad_id, (a.captured_at AT TIME ZONE 'Asia/Kolkata' - interval '6 hours')::date d,
           sabhi_bucket_of_account(ae.account_id) acct
    FROM lead_attribution_mv a LEFT JOIN ad_entities ae ON ae.entity_id = a.ad_id
  )
  SELECT s.business_date, s.k, c.cash,
    CASE WHEN s.channel ILIKE '%Google%' THEN 'google'
         WHEN fa.acct IS NOT NULL THEN fa.acct
         ELSE 'meta_unidentified' END,
    fa.ad_id, fa.d
  FROM s LEFT JOIN c ON c.d = s.business_date AND c.k = s.k
  LEFT JOIN fa ON fa.email_key = s.k;
$$;

-- The chain of figures per Sabhi line for a window.
CREATE OR REPLACE FUNCTION public.sabhi_chain(p_start date, p_end date)
RETURNS TABLE(bucket text, spend numeric, clicks bigint, page_views bigint, registrations bigint,
              attended bigint, at_price bigint, buyers bigint, cash numeric, last_spend date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH b(bucket) AS (VALUES ('1249430309131428'),('1109475161619539'),('1488704194840585'),('google'),('meta_unidentified')),
  sp AS (
    SELECT sabhi_bucket_of_account(account_id) bucket, sum(spend) spend, sum(link_clicks)::bigint clicks,
           sum(landing_page_views)::bigint lpv
    FROM daily_metrics WHERE level='ad' AND date BETWEEN p_start AND p_end
    GROUP BY 1
  ),
  ls AS (
    SELECT sabhi_bucket_of_account(account_id) bucket, max(date) d FROM daily_metrics
    WHERE level='ad' AND spend > 0 AND date <= p_end GROUP BY 1
  ),
  r AS (SELECT * FROM sabhi_first_regs(p_start, p_end)),
  att AS (
    SELECT r.bucket, r.email_key, max(z.total_duration_sec) mx
    FROM r JOIN zoom_attendance z ON z.email = r.email_key
    JOIN zoom_sessions s ON s.session_uuid = z.session_uuid AND s.session_role = 'live'
      AND s.business_date BETWEEN r.reg_date AND r.reg_date + 7
    GROUP BY 1,2
  ),
  sa AS (SELECT * FROM sabhi_sales(p_start, p_end))
  SELECT b.bucket,
    sp.spend, sp.clicks, sp.lpv,
    (SELECT count(DISTINCT email_key) FROM r WHERE r.bucket=b.bucket),
    (SELECT count(*) FROM att WHERE att.bucket=b.bucket),
    (SELECT count(*) FROM att WHERE att.bucket=b.bucket AND mx >= 5400),
    (SELECT count(*) FROM sa WHERE sa.bucket=b.bucket),
    (SELECT sum(sa.cash) FROM sa WHERE sa.bucket=b.bucket),
    CASE WHEN b.bucket='google' THEN DATE '2026-08-26' ELSE ls.d END
  FROM b LEFT JOIN sp ON sp.bucket=b.bucket LEFT JOIN ls ON ls.bucket=b.bucket;
$$;

-- Per advertisement, Sabhi Meta accounts only.
CREATE OR REPLACE FUNCTION public.sabhi_ads(p_start date, p_end date)
RETURNS TABLE(ad_id text, ad_name text, account_id text, spend numeric, page_views bigint,
              registrations bigint, buyers bigint, cash numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH sp AS (
    SELECT entity_id, max(account_id) account_id, sum(spend) spend, sum(landing_page_views)::bigint lpv
    FROM daily_metrics WHERE level='ad' AND date BETWEEN p_start AND p_end
      AND sabhi_bucket_of_account(account_id) IN ('1249430309131428','1109475161619539','1488704194840585')
    GROUP BY 1
  ),
  r AS (SELECT ad_id, count(DISTINCT email_key) n FROM sabhi_first_regs(p_start, p_end) WHERE ad_id IS NOT NULL GROUP BY 1),
  s AS (SELECT ad_id, count(*) n, sum(cash) cash FROM sabhi_sales(p_start, p_end) WHERE ad_id IS NOT NULL GROUP BY 1)
  SELECT sp.entity_id, ae.name, replace(sp.account_id,'act_',''), sp.spend, sp.lpv,
         coalesce(r.n,0), coalesce(s.n,0), s.cash
  FROM sp LEFT JOIN ad_entities ae ON ae.entity_id = sp.entity_id
  LEFT JOIN r ON r.ad_id = sp.entity_id LEFT JOIN s ON s.ad_id = sp.entity_id
  WHERE sp.spend > 0;
$$;

REVOKE ALL ON FUNCTION public.sabhi_first_regs(date,date), public.sabhi_sales(date,date),
  public.sabhi_chain(date,date), public.sabhi_ads(date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sabhi_first_regs(date,date), public.sabhi_sales(date,date),
  public.sabhi_chain(date,date), public.sabhi_ads(date,date) TO service_role, authenticated;