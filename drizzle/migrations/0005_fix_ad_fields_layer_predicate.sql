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
      CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'Google Ads'
           WHEN p.lead_id IS NOT NULL THEN p.display_name
           WHEN nm.lead_id IS NOT NULL THEN nm.display_name
           WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL AND k.lead_id IS NULL
             THEN 'Unrecognized: ' || left(coalesce(b.v_utm, b.v_ghl, b.v_pab), 80)
           ELSE 'No source recorded' END AS src,
      CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'Google Ads'
           WHEN p.lead_id IS NOT NULL THEN p.channel_group
           WHEN nm.lead_id IS NOT NULL THEN 'Meta ads'
           WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL AND k.lead_id IS NULL THEN 'Unrecognized'
           ELSE 'No source recorded' END AS ch,
      CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'confirmed'
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
$function$;
