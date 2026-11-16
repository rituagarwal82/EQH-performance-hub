-- Owner's final source rulings, 14 Sep 2026.

-- 1) Collaboration coaches (dictionary layers).
UPDATE public.source_dictionary
   SET display_name = 'Collaboration: Coach Badri', channel_group = 'Collaboration', updated_at = now()
 WHERE display_name = 'Collaboration: Badri (coach friend)';

INSERT INTO public.source_dictionary
  (raw_value, layer, match_kind, channel_group, display_name, is_acquisition, is_paid, confidence, note)
SELECT v.raw, l.layer, 'prefix', v.ch, v.dn, v.acq, false, v.conf,
       'Owner ruling 14 Sep 2026: collaboration coaches / non-source.'
  FROM (VALUES
    ('SIDZ',        'Collaboration', 'Collaboration: Coach Siddharth Rajshekhar', true,  'confirmed'),
    ('Sidz',        'Collaboration', 'Collaboration: Coach Siddharth Rajshekhar', true,  'confirmed'),
    ('TechnoFunda', 'Collaboration', 'Collaboration: Coach Vivek Mashrani',       true,  'confirmed'),
    ('SWETAS',      'Collaboration', 'Collaboration: Coach Shweta Samota',        true,  'confirmed'),
    ('FWAIEQH',     'Collaboration', 'Collaboration: Coach Avinash Mada',         true,  'confirmed'),
    ('BADRI',       'Collaboration', 'Collaboration: Coach Badri',                true,  'confirmed'),
    ('DESDKit',     'Not a source',  'Not a source',                              false, 'unknown')
  ) AS v(raw, ch, dn, acq, conf)
  CROSS JOIN (VALUES ('utm'), ('ghl_source')) AS l(layer)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.source_dictionary d
    WHERE d.layer = l.layer AND lower(d.raw_value) = lower(v.raw));

-- 2) Google Ads was Sabhi Digital's.
UPDATE public.source_dictionary
   SET channel_group = 'Sabhi Digital – Google Ads', updated_at = now()
 WHERE channel_group = 'Google Ads';

-- 3) Team ledger source column: collaborations, DESDKit, unchanged rest.
CREATE OR REPLACE FUNCTION public.team_source_label(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  WITH v AS (SELECT lower(btrim(coalesce(p_raw,''))) AS s)
  SELECT CASE
    WHEN s = '' OR s LIKE '#n/a%' OR s = 'unknown' OR s = 'na' THEN NULL
    WHEN s = 'desdkit' THEN NULL                      -- owner: not a source
    WHEN s LIKE 'sidz%' THEN 'Collaboration: Coach Siddharth Rajshekhar'
    WHEN s LIKE 'technofunda%' THEN 'Collaboration: Coach Vivek Mashrani'
    WHEN s LIKE 'swetas%' THEN 'Collaboration: Coach Shweta Samota'
    WHEN s LIKE 'fwaieqh%' THEN 'Collaboration: Coach Avinash Mada'
    WHEN s LIKE 'badri%' THEN 'Collaboration: Coach Badri'
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

-- 4) Matrix: ScaleX team answers are team-confirmed unless hard ad-account evidence disagrees.
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
           (ft.unified_channel LIKE '%Meta ads%'
             AND ft.unified_channel NOT LIKE '%unknown%'
             AND ft.unified_confidence IN ('confirmed','recovered from ad fields')) AS hard_ad,
           li.is_new_sale, li.counts_as_sale, li.amount_received
      FROM public.ledger_inflow li
      LEFT JOIN ft ON ft.email_key = li.email_key
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND (li.is_new_sale OR li.counts_as_sale)
  ),
  flagged AS (
    SELECT *,
      (team IS NOT NULL
        AND (ch IN ('No source recorded','No lead record','Old database (before tracking)')
             OR (team = 'ScaleX (agency, closed)' AND NOT coalesce(hard_ad,false)))) AS use_team
      FROM raw_sales
  ),
  resolved AS (
    SELECT to_char(business_date,'YYYY-MM') AS m,
           CASE WHEN use_team THEN team ELSE ch END AS ch,
           CASE WHEN use_team THEN team ELSE src END AS src,
           CASE WHEN use_team THEN NULL ELSE tl END AS tl,
           CASE WHEN use_team THEN 'team-confirmed' ELSE conf END AS conf,
           is_new_sale, counts_as_sale, amount_received
      FROM flagged
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

-- 5) Disagreements: ScaleX team answers only dispute with hard ad-account evidence.
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
     AND (public.team_source_label(li.source_of_student_raw) <> 'ScaleX (agency, closed)'
          OR (ft.unified_channel LIKE '%Meta ads%'
              AND ft.unified_channel NOT LIKE '%unknown%'
              AND ft.unified_confidence IN ('confirmed','recovered from ad fields')))
   ORDER BY li.business_date DESC;
$$;

-- 6) Relabel already-resolved leads (no re-resolution needed for these two).
UPDATE public.lead_unified_source
   SET unified_channel = 'Sabhi Digital – Google Ads', updated_at = now()
 WHERE unified_channel = 'Google Ads';

UPDATE public.lead_unified_source
   SET unified_source = 'Collaboration: Coach Badri', updated_at = now()
 WHERE unified_source = 'Collaboration: Badri (coach friend)';
CREATE OR REPLACE FUNCTION public.rebuild_unified_source_chunk(p_bucket integer, p_buckets integer DEFAULT 8)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE n integer;
BEGIN
  WITH b AS (
    SELECT l.lead_id,
           coalesce(l.email_key, l.phone_key, l.lead_id) AS ident,
           coalesce(l.business_date, (l.captured_at AT TIME ZONE 'UTC')::date, current_date) AS d,
           coalesce(l.captured_at, l.synced_at) AS cap_at,
           l.ad_entity_ref,
           nullif(btrim(l.utm_source),'') AS v_utm,
           nullif(btrim(l.utm_campaign),'') AS v_camp,
           nullif(btrim(l.raw->>'source'),'') AS v_ghl,
           (SELECT nullif(btrim(cf->>'value'),'')
              FROM jsonb_array_elements(coalesce(l.raw->'customFields','[]'::jsonb)) cf
             WHERE cf->>'id' = 'EI3pLOonDYisMHcIS9Qv' LIMIT 1) AS v_pab,
           (SELECT nullif(btrim(cf->>'value'),'')
              FROM jsonb_array_elements(coalesce(l.raw->'customFields','[]'::jsonb)) cf
             WHERE cf->>'id' = '3SZ84WVD7NnPDhI4qmOF' LIMIT 1) AS v_adcf,
           l.tags, l.gclid
      FROM public.leads l
     WHERE mod(abs(hashtext(l.lead_id)), p_buckets) = p_bucket
  ), v AS (
    SELECT lead_id, d, 'utm_campaign'::text AS layer, 0 AS prio, v_camp AS val FROM b WHERE v_camp IS NOT NULL
    UNION ALL SELECT lead_id, d, 'utm', 1, v_utm FROM b WHERE v_utm IS NOT NULL
    UNION ALL SELECT lead_id, d, 'ghl_source', 2, v_ghl FROM b WHERE v_ghl IS NOT NULL
    UNION ALL SELECT lead_id, d, 'pabbly_cf', 3, v_pab FROM b WHERE v_pab IS NOT NULL
    UNION ALL SELECT b.lead_id, b.d, 'tag', 4, t FROM b, unnest(coalesce(b.tags,'{}'::text[])) t
  ), m AS (
    SELECT v.lead_id, v.layer, v.prio, dd.display_name, dd.channel_group, dd.is_acquisition,
           CASE WHEN v.layer = 'tag' THEN 'inferred' ELSE dd.confidence END AS confidence,
           dd.match_kind, dd.raw_value
      FROM v
      JOIN public.source_dictionary dd
        ON dd.layer = v.layer
       AND ( (dd.match_kind = 'exact'  AND lower(dd.raw_value) = lower(btrim(v.val)))
          OR (dd.match_kind = 'prefix' AND lower(btrim(v.val)) LIKE lower(dd.raw_value) || '%') )
       AND (dd.valid_from IS NULL OR v.d >= dd.valid_from)
       AND (dd.valid_to   IS NULL OR v.d <= dd.valid_to)
  ), num AS (
    SELECT b.lead_id, coalesce(e.name, 'Meta ads') AS display_name
      FROM b
      LEFT JOIN public.ad_entities e ON e.entity_id = b.v_camp AND e.level = 'campaign'
     WHERE b.v_camp ~ '^[0-9]{6,}$'
  ), p AS (
    SELECT DISTINCT ON (lead_id) lead_id, layer, display_name, channel_group, confidence
      FROM m
     WHERE is_acquisition AND confidence <> 'unknown'
     ORDER BY lead_id, prio, (match_kind = 'exact') DESC, length(raw_value) DESC
  ), tool AS (
    SELECT DISTINCT ON (lead_id) lead_id, display_name
      FROM m WHERE layer <> 'utm_campaign' AND is_acquisition AND confidence <> 'unknown'
     ORDER BY lead_id, prio, (match_kind = 'exact') DESC, length(raw_value) DESC
  ), known AS (
    SELECT DISTINCT lead_id FROM m
  ), base AS (
    SELECT b.lead_id, b.ident, b.cap_at, b.ad_entity_ref, b.v_camp, b.v_adcf,
      CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Sabhi Digital – Google Ads') THEN 'Google Ads'
           WHEN p.lead_id IS NOT NULL THEN p.display_name
           WHEN nm.lead_id IS NOT NULL THEN nm.display_name
           WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL AND k.lead_id IS NULL
             THEN 'Unrecognized: ' || left(coalesce(b.v_utm, b.v_ghl, b.v_pab), 80)
           ELSE 'No source recorded' END AS src,
      CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Sabhi Digital – Google Ads') THEN 'Sabhi Digital – Google Ads'
           WHEN p.lead_id IS NOT NULL THEN p.channel_group
           WHEN nm.lead_id IS NOT NULL THEN 'Meta ads'
           WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL AND k.lead_id IS NULL THEN 'Unrecognized'
           ELSE 'No source recorded' END AS ch,
      CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Sabhi Digital – Google Ads') THEN 'confirmed'
           WHEN p.lead_id IS NOT NULL THEN p.confidence
           WHEN nm.lead_id IS NOT NULL THEN 'confirmed'
           ELSE 'unknown' END AS conf,
      CASE WHEN p.lead_id IS NOT NULL THEN p.layer
           WHEN nm.lead_id IS NOT NULL THEN 'utm_campaign'
           WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL AND k.lead_id IS NULL THEN 'unmatched'
           ELSE 'none' END AS layer,
      CASE WHEN p.layer = 'utm_campaign' AND t.display_name IS DISTINCT FROM p.display_name
           THEN t.display_name END AS tl
    FROM b
    LEFT JOIN p ON p.lead_id = b.lead_id
    LEFT JOIN tool t ON t.lead_id = b.lead_id
    LEFT JOIN num nm ON nm.lead_id = b.lead_id
    LEFT JOIN known k ON k.lead_id = b.lead_id
  ), adf AS (
    SELECT base.lead_id, public.ad_field_meta_label(base.v_adcf) AS label
      FROM base
     WHERE base.v_adcf IS NOT NULL
       AND base.ch = 'No source recorded'
       AND NOT EXISTS (
         SELECT 1 FROM public.lead_unified_source e
          JOIN public.leads el ON el.lead_id = e.lead_id
          WHERE e.ident = base.ident
            AND e.lead_id <> base.lead_id
            AND coalesce(el.captured_at, el.synced_at) < base.cap_at
            AND e.unified_source NOT IN ('No source recorded','Old database (before tracking)')
       )
  )
  INSERT INTO public.lead_unified_source
    (lead_id, ident, unified_source, unified_channel, unified_confidence, resolution_layer, unified_tool, updated_at)
  SELECT base.lead_id, base.ident,
    CASE WHEN base.ch = 'Meta ads'
           THEN public.meta_agency_label(base.ad_entity_ref, base.v_camp)
         WHEN af.label IS NOT NULL THEN af.label
         WHEN base.ch = 'No source recorded' AND base.cap_at < timestamptz '2026-01-07 00:00:00+05:30'
           THEN 'Old database (before tracking)'
         ELSE base.src END,
    CASE WHEN base.ch = 'Meta ads'
           THEN public.meta_agency_label(base.ad_entity_ref, base.v_camp)
         WHEN af.label IS NOT NULL THEN af.label
         WHEN base.ch = 'No source recorded' AND base.cap_at < timestamptz '2026-01-07 00:00:00+05:30'
           THEN 'Old database (before tracking)'
         ELSE base.ch END,
    CASE WHEN base.ch <> 'Meta ads' AND af.label IS NOT NULL THEN 'recovered from ad fields'
         ELSE base.conf END,
    CASE WHEN base.ch <> 'Meta ads' AND af.label IS NOT NULL THEN 'ad_fields'
         WHEN base.ch = 'No source recorded' AND base.cap_at < timestamptz '2026-01-07 00:00:00+05:30'
           THEN 'legacy_import' ELSE base.layer END,
    CASE WHEN base.ch = 'Meta ads' AND base.tl IS NULL AND base.src <> 'Meta ads' THEN base.src ELSE base.tl END,
    now()
  FROM base LEFT JOIN adf af ON af.lead_id = base.lead_id
  ON CONFLICT (lead_id) DO UPDATE SET
    ident = excluded.ident,
    unified_source = excluded.unified_source,
    unified_channel = excluded.unified_channel,
    unified_confidence = excluded.unified_confidence,
    resolution_layer = excluded.resolution_layer,
    unified_tool = excluded.unified_tool,
    updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$

;
