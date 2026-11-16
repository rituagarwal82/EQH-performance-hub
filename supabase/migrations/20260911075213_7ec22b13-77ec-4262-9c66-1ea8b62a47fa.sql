CREATE TABLE IF NOT EXISTS public.lead_unified_source (
  lead_id text primary key,
  ident text not null,
  unified_source text not null,
  unified_channel text not null,
  unified_confidence text not null,
  resolution_layer text not null,
  updated_at timestamptz not null default now()
);
GRANT ALL ON public.lead_unified_source TO service_role;
ALTER TABLE public.lead_unified_source ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role manages unified source"
  ON public.lead_unified_source FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS lead_unified_source_ident_idx ON public.lead_unified_source (ident);
CREATE INDEX IF NOT EXISTS lead_unified_source_channel_idx ON public.lead_unified_source (unified_channel);

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
  ), p AS (
    SELECT DISTINCT ON (v.lead_id) v.lead_id, v.layer,
           dd.display_name, dd.channel_group,
           CASE WHEN v.layer = 'tag' THEN 'inferred' ELSE dd.confidence END AS confidence
      FROM v
      JOIN public.source_dictionary dd
        ON dd.layer = v.layer
       AND ( (dd.match_kind = 'exact'  AND lower(dd.raw_value) = lower(btrim(v.val)))
          OR (dd.match_kind = 'prefix' AND lower(btrim(v.val)) LIKE lower(dd.raw_value) || '%') )
       AND (dd.valid_from IS NULL OR v.d >= dd.valid_from)
       AND (dd.valid_to   IS NULL OR v.d <= dd.valid_to)
     WHERE dd.is_acquisition AND dd.confidence <> 'unknown'
     ORDER BY v.lead_id, v.prio, (dd.match_kind = 'exact') DESC, length(dd.raw_value) DESC
  )
  INSERT INTO public.lead_unified_source
    (lead_id, ident, unified_source, unified_channel, unified_confidence, resolution_layer, updated_at)
  SELECT b.lead_id, b.ident,
    CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'Google Ads'
         WHEN p.lead_id IS NOT NULL THEN p.display_name
         WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL THEN 'Unrecognized: ' || left(coalesce(b.v_utm, b.v_ghl, b.v_pab), 80)
         ELSE 'No source recorded' END,
    CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'Google Ads'
         WHEN p.lead_id IS NOT NULL THEN p.channel_group
         WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL THEN 'Unrecognized'
         ELSE 'No source recorded' END,
    CASE WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'confirmed'
         WHEN p.lead_id IS NOT NULL THEN p.confidence
         ELSE 'unknown' END,
    CASE WHEN p.lead_id IS NOT NULL THEN p.layer
         WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL THEN 'unmatched'
         ELSE 'none' END,
    now()
  FROM b LEFT JOIN p ON p.lead_id = b.lead_id
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

CREATE OR REPLACE FUNCTION public.apply_first_touch_source()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE n integer;
BEGIN
  WITH ranked AS (
    SELECT DISTINCT ON (u.ident) u.ident, u.unified_source, u.unified_channel,
           u.unified_confidence, u.resolution_layer
      FROM public.lead_unified_source u
      JOIN public.leads l ON l.lead_id = u.lead_id
     ORDER BY u.ident, (u.resolution_layer = 'none'), coalesce(l.captured_at, l.synced_at) NULLS LAST, u.lead_id
  )
  UPDATE public.lead_unified_source u
     SET unified_source = r.unified_source,
         unified_channel = r.unified_channel,
         unified_confidence = r.unified_confidence,
         resolution_layer = r.resolution_layer,
         updated_at = now()
    FROM ranked r
   WHERE r.ident = u.ident
     AND (u.unified_source IS DISTINCT FROM r.unified_source
       OR u.unified_channel IS DISTINCT FROM r.unified_channel
       OR u.unified_confidence IS DISTINCT FROM r.unified_confidence
       OR u.resolution_layer IS DISTINCT FROM r.resolution_layer);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.apply_first_touch_source() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_first_touch_source() TO service_role;

ALTER TABLE public.leads
  DROP COLUMN IF EXISTS unified_source,
  DROP COLUMN IF EXISTS unified_channel,
  DROP COLUMN IF EXISTS unified_confidence,
  DROP COLUMN IF EXISTS resolution_layer;

DROP FUNCTION IF EXISTS public.refresh_unified_source();
