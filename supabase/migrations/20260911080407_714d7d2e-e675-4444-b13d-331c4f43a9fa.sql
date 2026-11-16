ALTER TABLE public.source_dictionary DROP CONSTRAINT source_dictionary_layer_check;
ALTER TABLE public.source_dictionary ADD CONSTRAINT source_dictionary_layer_check
  CHECK (layer = ANY (ARRAY['utm','ghl_source','tag','pabbly_cf','utm_campaign']));

ALTER TABLE public.lead_unified_source ADD COLUMN IF NOT EXISTS unified_tool text;

DELETE FROM public.source_dictionary WHERE layer = 'utm_campaign';

INSERT INTO public.source_dictionary
  (raw_value, layer, match_kind, channel_group, display_name, is_acquisition, is_paid, valid_from, valid_to, confidence, note)
VALUES
  ('GunjanShouts','utm_campaign','exact','Influencer podcast','Podcast: Gunjan',true,false,NULL,NULL,'confirmed','Owner-confirmed: campaign carries the influencer, source carries the tool.'),
  ('TS_','utm_campaign','prefix','Tushar (agency, closed)','Tushar (agency, closed)',true,true,NULL,NULL,'confirmed','Tushar campaign fingerprint riding on generic sources. Costs not in the system.'),
  ('SD_','utm_campaign','prefix','Meta ads','Sabhi Digital (Meta)',true,true,NULL,NULL,'confirmed','Sabhi Digital campaign naming.'),
  ('DG_','utm_campaign','prefix','Google Ads','Google Ads',true,true,NULL,'2026-08-26','confirmed','Paid-Google wave. Google spend never recorded in system.'),
  ('B_DG_','utm_campaign','prefix','Google Ads','Google Ads',true,true,NULL,'2026-08-26','confirmed','Paid-Google wave. Google spend never recorded in system.'),
  ('DG_','utm_campaign','prefix','Organic search','Organic search',true,false,'2026-08-27',NULL,'confirmed','Google Ads stopped 26 Aug 2026 — old links only.'),
  ('B_DG_','utm_campaign','prefix','Organic search','Organic search',true,false,'2026-08-27',NULL,'confirmed','Google Ads stopped 26 Aug 2026 — old links only.'),
  ('Scaling_','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('ADV ','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('ADV_','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('Leads_','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('TOF_','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('BOF_','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('LLA_','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('Top1LAL','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('B_Hotleads','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('B_CT_','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('B_AdvPlus','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('B_BhagwatGeeta','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('ToolQuiz_','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('Sales','utm_campaign','prefix','Meta ads','Meta ads',true,true,NULL,NULL,'confirmed','Meta campaign family.'),
  ('bio','utm_campaign','exact','Organic / own','Instagram bio',true,false,NULL,NULL,'confirmed','Merged with source-level Instagram bio.'),
  ('story','utm_campaign','exact','Organic / own','Instagram story',true,false,NULL,NULL,'confirmed','Merged with source-level Instagram story.');

CREATE OR REPLACE FUNCTION public.rebuild_unified_source_chunk(p_bucket integer, p_buckets integer DEFAULT 8)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE n integer;
BEGIN
  WITH b AS (
    SELECT l.lead_id,
           coalesce(l.email_key, l.phone_key, l.lead_id) AS ident,
           coalesce(l.business_date, (l.captured_at AT TIME ZONE 'UTC')::date, current_date) AS d,
           nullif(btrim(l.utm_source),'') AS v_utm,
           nullif(btrim(l.utm_campaign),'') AS v_camp,
           nullif(btrim(l.raw->>'source'),'') AS v_ghl,
           (SELECT nullif(btrim(cf->>'value'),'')
              FROM jsonb_array_elements(coalesce(l.raw->'customFields','[]'::jsonb)) cf
             WHERE cf->>'id' = 'EI3pLOonDYisMHcIS9Qv' LIMIT 1) AS v_pab,
           l.tags, l.gclid
      FROM public.leads l
     WHERE mod(abs(hashtext(l.lead_id)), p_buckets) = p_bucket
  ), v AS (
    -- The campaign layer runs first: when the campaign names a person or an
    -- agency it is MORE specific than the tool in utm_source, so it decides the
    -- channel and the tool is kept beside it as detail.
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
    -- A purely numeric campaign is a Meta campaign id; resolve it to the real
    -- campaign where we hold it, otherwise record it as Meta ads.
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
    -- Sub-detail: the tool/source the campaign rode on, kept only when the
    -- campaign decided the channel.
    SELECT DISTINCT ON (lead_id) lead_id, display_name
      FROM m WHERE layer <> 'utm_campaign' AND is_acquisition AND confidence <> 'unknown'
     ORDER BY lead_id, prio, (match_kind = 'exact') DESC, length(raw_value) DESC
  ), known AS (
    SELECT DISTINCT lead_id FROM m
  )
  INSERT INTO public.lead_unified_source
    (lead_id, ident, unified_source, unified_channel, unified_confidence, resolution_layer, unified_tool, updated_at)
  SELECT b.lead_id, b.ident,
    CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'Google Ads'
         WHEN p.lead_id IS NOT NULL THEN p.display_name
         WHEN nm.lead_id IS NOT NULL THEN nm.display_name
         WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL AND k.lead_id IS NULL
           THEN 'Unrecognized: ' || left(coalesce(b.v_utm, b.v_ghl, b.v_pab), 80)
         ELSE 'No source recorded' END,
    CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'Google Ads'
         WHEN p.lead_id IS NOT NULL THEN p.channel_group
         WHEN nm.lead_id IS NOT NULL THEN 'Meta ads'
         WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL AND k.lead_id IS NULL THEN 'Unrecognized'
         ELSE 'No source recorded' END,
    CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'confirmed'
         WHEN p.lead_id IS NOT NULL THEN p.confidence
         WHEN nm.lead_id IS NOT NULL THEN 'confirmed'
         ELSE 'unknown' END,
    CASE WHEN p.lead_id IS NOT NULL THEN p.layer
         WHEN nm.lead_id IS NOT NULL THEN 'utm_campaign'
         WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL AND k.lead_id IS NULL THEN 'unmatched'
         ELSE 'none' END,
    CASE WHEN p.layer = 'utm_campaign' AND t.display_name IS DISTINCT FROM p.display_name
         THEN t.display_name END,
    now()
  FROM b
  LEFT JOIN p ON p.lead_id = b.lead_id
  LEFT JOIN tool t ON t.lead_id = b.lead_id
  LEFT JOIN num nm ON nm.lead_id = b.lead_id
  LEFT JOIN known k ON k.lead_id = b.lead_id
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
$function$;

CREATE OR REPLACE FUNCTION public.apply_first_touch_source()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE n integer;
BEGIN
  WITH ranked AS (
    SELECT DISTINCT ON (u.ident) u.ident, u.unified_source, u.unified_channel,
           u.unified_confidence, u.resolution_layer, u.unified_tool
      FROM public.lead_unified_source u
      JOIN public.leads l ON l.lead_id = u.lead_id
     ORDER BY u.ident, (u.resolution_layer = 'none'), coalesce(l.captured_at, l.synced_at) NULLS LAST, u.lead_id
  )
  UPDATE public.lead_unified_source u
     SET unified_source = r.unified_source,
         unified_channel = r.unified_channel,
         unified_confidence = r.unified_confidence,
         resolution_layer = r.resolution_layer,
         unified_tool = r.unified_tool,
         updated_at = now()
    FROM ranked r
   WHERE r.ident = u.ident
     AND (u.unified_source IS DISTINCT FROM r.unified_source
       OR u.unified_channel IS DISTINCT FROM r.unified_channel
       OR u.unified_confidence IS DISTINCT FROM r.unified_confidence
       OR u.resolution_layer IS DISTINCT FROM r.resolution_layer
       OR u.unified_tool IS DISTINCT FROM r.unified_tool);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$function$;
