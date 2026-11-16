INSERT INTO public.source_dictionary
 (raw_value, layer, match_kind, channel_group, display_name, is_acquisition, is_paid, valid_from, valid_to, confidence, note) VALUES
('Facebook','ghl_source','exact','Meta ads','Meta ads',true,true,null,null,'confirmed',null),
('FACEBOOK_P','ghl_source','exact','Meta ads','Meta ads',true,true,null,null,'confirmed',null),
('fb','ghl_source','exact','Meta ads','Meta ads',true,true,null,null,'confirmed',null),
('ig','ghl_source','exact','Meta ads','Meta ads',true,true,null,null,'confirmed',null),
('insta','ghl_source','exact','Meta ads','Meta ads',true,true,null,null,'confirmed',null),
('meta','ghl_source','exact','Meta ads','Meta ads',true,true,null,null,'confirmed',null),
('Rajdeep-','ghl_source','prefix','Meta ads','Meta ads — RJ team',true,true,null,null,'inferred','Lead-system label naming the RJ team'),
('sabhidigital','utm','exact','Meta ads','Meta ads — SD team',true,true,null,null,'inferred',null),
('sabhi_digital-youtube','utm','exact','Meta ads','Meta ads — SD team',true,true,null,null,'inferred',null),
('Google','ghl_source','exact','Google Ads','Google Ads',true,true,null,'2026-08-26','confirmed','Google spend never recorded in system — costs invisible, same treatment as SX era'),
('Google','ghl_source','exact','Organic search','Organic search (Google)',true,false,'2026-08-27',null,'confirmed',null),
('youtube','ghl_source','exact','Google Ads','Google Ads (YouTube)',true,true,null,'2026-08-26','confirmed',null),
('youtube','ghl_source','exact','Organic search','Organic search (YouTube)',true,false,'2026-08-27',null,'confirmed',null),
('ig_organic','utm','exact','Organic / own','Instagram organic',true,false,null,null,'inferred',null),
('999Email','ghl_source','exact','Not acquisition','Existing-lead campaign',false,false,null,null,'confirmed',null),
('NavratriRitual','ghl_source','exact','Not acquisition','Other funnel (parked)',false,false,null,null,'confirmed',null),
('zoom','ghl_source','exact','Unrecognized','Junk value',false,false,null,null,'unknown',null),
('wo','ghl_source','exact','Unrecognized','Junk value',false,false,null,null,'unknown',null),
('_47Paid','ghl_source','exact','Unrecognized','Junk value',false,false,null,null,'unknown',null),
('Webinar Qualification Quiz','ghl_source','exact','Unrecognized','Not a source label',false,false,null,null,'unknown',null),
('Energy Queens Hub','ghl_source','exact','Unrecognized','Not a source label',false,false,null,null,'unknown',null),
('Email','ghl_source','exact','Unrecognized','Junk value',false,false,null,null,'unknown',null),
('email','utm','exact','Unrecognized','Junk value',false,false,null,null,'unknown',null),
('-','ghl_source','exact','Unrecognized','Junk value',false,false,null,null,'unknown',null),
('newlp_','utm','exact','Unrecognized','Unfilled template',false,false,null,null,'unknown',null),
('/energy-scan-IG','ghl_source','exact','Organic / own','Instagram organic (energy-scan tool)',true,false,null,null,'inferred',null)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.rebuild_unified_source_chunk(p_bucket integer, p_buckets integer DEFAULT 8)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE n integer;
BEGIN
  WITH b AS (
    SELECT l.lead_id,
           coalesce(l.email_key, l.phone_key, l.lead_id) AS ident,
           coalesce(l.business_date, (l.captured_at AT TIME ZONE 'UTC')::date, current_date) AS d,
           nullif(btrim(l.utm_source),'') AS v_utm,
           nullif(btrim(l.raw->>'source'),'') AS v_ghl,
           (SELECT nullif(btrim(cf->>'value'),'')
              FROM jsonb_array_elements(coalesce(l.raw->'customFields','[]'::jsonb)) cf
             WHERE cf->>'id' = 'EI3pLOonDYisMHcIS9Qv' LIMIT 1) AS v_pab,
           l.tags, l.gclid
      FROM public.leads l
     WHERE mod(abs(hashtext(l.lead_id)), p_buckets) = p_bucket
  ), v AS (
    SELECT lead_id, d, 'utm'::text AS layer, 1 AS prio, v_utm AS val FROM b WHERE v_utm IS NOT NULL
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
  ), p AS (
    SELECT DISTINCT ON (lead_id) lead_id, layer, display_name, channel_group, confidence
      FROM m
     WHERE is_acquisition AND confidence <> 'unknown'
     ORDER BY lead_id, prio, (match_kind = 'exact') DESC, length(raw_value) DESC
  ), known AS (
    SELECT DISTINCT lead_id FROM m
  )
  INSERT INTO public.lead_unified_source
    (lead_id, ident, unified_source, unified_channel, unified_confidence, resolution_layer, updated_at)
  SELECT b.lead_id, b.ident,
    CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'Google Ads'
         WHEN p.lead_id IS NOT NULL THEN p.display_name
         WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL AND k.lead_id IS NULL
           THEN 'Unrecognized: ' || left(coalesce(b.v_utm, b.v_ghl, b.v_pab), 80)
         ELSE 'No source recorded' END,
    CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'Google Ads'
         WHEN p.lead_id IS NOT NULL THEN p.channel_group
         WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL AND k.lead_id IS NULL THEN 'Unrecognized'
         ELSE 'No source recorded' END,
    CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'confirmed'
         WHEN p.lead_id IS NOT NULL THEN p.confidence
         ELSE 'unknown' END,
    CASE WHEN p.lead_id IS NOT NULL THEN p.layer
         WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL AND k.lead_id IS NULL THEN 'unmatched'
         ELSE 'none' END,
    now()
  FROM b
  LEFT JOIN p ON p.lead_id = b.lead_id
  LEFT JOIN known k ON k.lead_id = b.lead_id
  ON CONFLICT (lead_id) DO UPDATE SET
    ident = excluded.ident,
    unified_source = excluded.unified_source,
    unified_channel = excluded.unified_channel,
    unified_confidence = excluded.unified_confidence,
    resolution_layer = excluded.resolution_layer,
    updated_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.rebuild_unified_source_chunk(integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_unified_source_chunk(integer,integer) TO service_role;
