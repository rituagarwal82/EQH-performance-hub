-- 1) TS_ campaigns belong to Sabhi Digital (account 1249430309131428), not Tushar.
UPDATE public.source_dictionary
   SET channel_group = 'Meta ads',
       display_name  = 'TS campaigns',
       is_paid       = true,
       is_acquisition = true,
       confidence    = 'confirmed',
       note          = 'TS_ campaigns all ran on Ritu Agarwal 2 (SD). Owner-confirmed 14 Sep 2026.',
       updated_at    = now()
 WHERE layer = 'utm_campaign' AND match_kind = 'prefix' AND raw_value = 'TS_';

INSERT INTO public.source_dictionary
  (raw_value, layer, match_kind, channel_group, display_name, is_acquisition, is_paid, confidence, note)
SELECT 'TS Sales Free', 'utm_campaign', 'prefix', 'Meta ads', 'TS campaigns', true, true, 'confirmed',
       'TS Sales Free campaigns ran on Ritu Agarwal 2 (SD). Owner-confirmed 14 Sep 2026.'
 WHERE NOT EXISTS (
   SELECT 1 FROM public.source_dictionary
    WHERE layer='utm_campaign' AND match_kind='prefix' AND raw_value='TS Sales Free');

-- 2) Normalise the accounts team's own source column into channel labels.
CREATE OR REPLACE FUNCTION public.team_source_label(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  WITH v AS (SELECT lower(btrim(coalesce(p_raw,''))) AS s)
  SELECT CASE
    WHEN s = '' OR s LIKE '#n/a%' OR s = 'unknown' OR s = 'na' THEN NULL
    WHEN s LIKE '%/%' THEN NULL                       -- ambiguous multi-source entry
    WHEN s LIKE 'sabhi%' OR s LIKE '%sabhi%' THEN 'Sabhi Digital – Meta ads'
    WHEN s IN ('sx','scalex','scale x') THEN 'ScaleX (agency, closed)'
    WHEN s LIKE 'rajdeep%' THEN 'Rajdeep (in-house) – Meta ads'
    WHEN s LIKE 'youtube%' THEN 'YouTube (organic)'
    WHEN s LIKE 'organic%' THEN 'Organic search'
    WHEN s LIKE 'gunjan%' THEN 'Podcast: Gunjan'
    WHEN s LIKE 'bhanu%' THEN 'Podcast: Bhanu'
    WHEN s LIKE 'tushar%' THEN 'Tushar (agency, closed)'
    WHEN s LIKE 'vlad%' THEN 'Vlad (agency, closed)'
    WHEN replace(replace(s, ',', '.'), '.', '') LIKE 'dr %shikha%' OR s LIKE 'dr%shikha%' THEN 'Team: Dr. Shikha'
    ELSE 'Team: ' || btrim(p_raw)
  END
  FROM v
$$;

GRANT EXECUTE ON FUNCTION public.team_source_label(text) TO authenticated, service_role, anon;

-- 3) Sale-level team-confirmed layer inside the source matrix.
CREATE OR REPLACE FUNCTION public.source_month_matrix(p_start date, p_end date)
RETURNS TABLE(month text, channel text, source text, tool text, confidence text, leads bigint, sales_team bigint, sales_paid bigint, cash numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH ft AS (
    SELECT DISTINCT ON (l.email_key) l.email_key, u.unified_source, u.unified_channel,
           u.unified_tool, u.unified_confidence, u.resolution_layer
      FROM public.leads l
      JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
     WHERE l.email_key IS NOT NULL
     ORDER BY l.email_key, l.captured_at NULLS LAST, l.lead_id
  ),
  raw_sales AS (
    SELECT li.business_date,
           coalesce(ft.unified_channel,'No lead record') AS ch,
           coalesce(ft.unified_source,'No lead record') AS src,
           ft.unified_tool AS tl,
           coalesce(ft.unified_confidence,'unknown') AS conf,
           public.team_source_label(li.source_of_student_raw) AS team,
           li.is_new_sale, li.counts_as_sale, li.amount_received
      FROM public.ledger_inflow li
      LEFT JOIN ft ON ft.email_key = li.email_key
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND (li.is_new_sale OR li.counts_as_sale)
  ),
  resolved AS (
    SELECT to_char(business_date,'YYYY-MM') AS m,
           CASE WHEN team IS NOT NULL AND ch IN ('No source recorded','No lead record','Old database (before tracking)')
                THEN team ELSE ch END AS ch,
           CASE WHEN team IS NOT NULL AND ch IN ('No source recorded','No lead record','Old database (before tracking)')
                THEN team ELSE src END AS src,
           CASE WHEN team IS NOT NULL AND ch IN ('No source recorded','No lead record','Old database (before tracking)')
                THEN NULL ELSE tl END AS tl,
           CASE WHEN team IS NOT NULL AND ch IN ('No source recorded','No lead record','Old database (before tracking)')
                THEN 'team-confirmed' ELSE conf END AS conf,
           is_new_sale, counts_as_sale, amount_received
      FROM raw_sales
  ),
  sales AS (
    SELECT m, ch, src, tl, conf,
           count(*) FILTER (WHERE is_new_sale) AS s_team,
           count(*) FILTER (WHERE counts_as_sale) AS s_paid,
           sum(amount_received) AS cash
      FROM resolved GROUP BY 1,2,3,4,5
  ),
  lead_counts AS (
    SELECT to_char(l.business_date,'YYYY-MM') AS m,
           u.unified_channel AS ch, u.unified_source AS src, u.unified_tool AS tl,
           u.unified_confidence AS conf, count(*) AS leads
      FROM public.leads l
      JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
     WHERE l.business_date BETWEEN p_start AND p_end
     GROUP BY 1,2,3,4,5
  )
  SELECT coalesce(s.m, c.m), coalesce(s.ch, c.ch), coalesce(s.src, c.src),
         coalesce(s.tl, c.tl), coalesce(s.conf, c.conf),
         coalesce(c.leads,0), coalesce(s.s_team,0), coalesce(s.s_paid,0), coalesce(s.cash,0)
    FROM sales s
    FULL OUTER JOIN lead_counts c
      ON c.m = s.m AND c.ch = s.ch AND c.src = s.src AND c.tl IS NOT DISTINCT FROM s.tl
   ORDER BY 1 DESC, 9 DESC, 6 DESC;
$$;

-- 4) Where tracking and the team disagree, tracking wins and the pair is listed.
CREATE OR REPLACE FUNCTION public.sale_source_disagreements(p_start date, p_end date)
RETURNS TABLE(sale_id text, business_date date, email text, tracking_answer text, team_answer text, evidence text, cash numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH ft AS (
    SELECT DISTINCT ON (l.email_key) l.email_key, u.unified_channel, u.unified_confidence, u.resolution_layer
      FROM public.leads l
      JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
     WHERE l.email_key IS NOT NULL
     ORDER BY l.email_key, l.captured_at NULLS LAST, l.lead_id
  )
  SELECT li.row_hash, li.business_date, li.email_key,
         ft.unified_channel,
         public.team_source_label(li.source_of_student_raw),
         ft.resolution_layer || ' · ' || ft.unified_confidence,
         li.amount_received
    FROM public.ledger_inflow li
    JOIN ft ON ft.email_key = li.email_key
   WHERE li.product_tier = 'L1_SILVER'
     AND li.business_date BETWEEN p_start AND p_end
     AND (li.is_new_sale OR li.counts_as_sale)
     AND public.team_source_label(li.source_of_student_raw) IS NOT NULL
     AND ft.unified_channel NOT IN ('No source recorded','Old database (before tracking)')
     AND ft.unified_channel <> public.team_source_label(li.source_of_student_raw)
     AND (ft.unified_confidence IN ('confirmed','recovered from ad fields')
          OR ft.resolution_layer IN ('utm','utm_campaign','ad_fields','ghl_source'))
   ORDER BY li.business_date DESC;
$$;

GRANT EXECUTE ON FUNCTION public.sale_source_disagreements(date, date) TO authenticated, service_role;
