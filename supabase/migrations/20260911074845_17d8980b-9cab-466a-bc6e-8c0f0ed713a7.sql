CREATE OR REPLACE FUNCTION public.refresh_unified_source()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '600s'
AS $fn$
DECLARE n integer := 0; hit integer; lo integer := 0; maxrn integer;
BEGIN
  CREATE TEMP TABLE _base ON COMMIT DROP AS
  SELECT l.lead_id,
         coalesce(l.email_key, l.phone_key, l.lead_id) AS ident,
         coalesce(l.captured_at, l.synced_at) AS at,
         coalesce(l.business_date, (l.captured_at AT TIME ZONE 'UTC')::date, current_date) AS d,
         nullif(btrim(l.utm_source),'') AS v_utm,
         nullif(btrim(l.raw->>'source'),'') AS v_ghl,
         (SELECT nullif(btrim(cf->>'value'),'')
            FROM jsonb_array_elements(coalesce(l.raw->'customFields','[]'::jsonb)) cf
           WHERE cf->>'id' = 'EI3pLOonDYisMHcIS9Qv' LIMIT 1) AS v_pab,
         l.tags, l.gclid
    FROM public.leads l;
  CREATE INDEX ON _base (lead_id);

  CREATE TEMP TABLE _vals ON COMMIT DROP AS
    SELECT lead_id, d, 'utm'::text AS layer, 1 AS prio, v_utm AS val FROM _base WHERE v_utm IS NOT NULL
    UNION ALL SELECT lead_id, d, 'ghl_source', 2, v_ghl FROM _base WHERE v_ghl IS NOT NULL
    UNION ALL SELECT lead_id, d, 'pabbly_cf', 3, v_pab FROM _base WHERE v_pab IS NOT NULL
    UNION ALL SELECT b.lead_id, b.d, 'tag', 4, t FROM _base b, unnest(coalesce(b.tags,'{}'::text[])) t;

  CREATE TEMP TABLE _pick ON COMMIT DROP AS
  SELECT DISTINCT ON (v.lead_id)
         v.lead_id, v.layer, v.val, dd.display_name, dd.channel_group,
         CASE WHEN v.layer = 'tag' THEN 'inferred' ELSE dd.confidence END AS confidence
    FROM _vals v
    JOIN public.source_dictionary dd
      ON dd.layer = v.layer
     AND ( (dd.match_kind = 'exact'  AND lower(dd.raw_value) = lower(btrim(v.val)))
        OR (dd.match_kind = 'prefix' AND lower(btrim(v.val)) LIKE lower(dd.raw_value) || '%') )
     AND (dd.valid_from IS NULL OR v.d >= dd.valid_from)
     AND (dd.valid_to   IS NULL OR v.d <= dd.valid_to)
   WHERE dd.is_acquisition AND dd.confidence <> 'unknown'
   ORDER BY v.lead_id, v.prio, (dd.match_kind = 'exact') DESC, length(dd.raw_value) DESC;
  CREATE INDEX ON _pick (lead_id);

  CREATE TEMP TABLE _lead_res ON COMMIT DROP AS
  SELECT b.lead_id, b.ident, b.at,
         CASE
           WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'Google Ads'
           WHEN p.lead_id IS NOT NULL THEN p.display_name
           WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL THEN 'Unrecognized: ' || left(coalesce(b.v_utm, b.v_ghl, b.v_pab), 80)
           ELSE 'No source recorded' END AS src,
         CASE
           WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'Google Ads'
           WHEN p.lead_id IS NOT NULL THEN p.channel_group
           WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL THEN 'Unrecognized'
           ELSE 'No source recorded' END AS chan,
         CASE
           WHEN b.gclid IS NOT NULL AND p.channel_group IN ('Organic search','Google Ads') THEN 'confirmed'
           WHEN p.lead_id IS NOT NULL THEN p.confidence
           ELSE 'unknown' END AS conf,
         CASE
           WHEN p.lead_id IS NOT NULL THEN p.layer
           WHEN coalesce(b.v_utm, b.v_ghl, b.v_pab) IS NOT NULL THEN 'unmatched'
           ELSE 'none' END AS layer
    FROM _base b LEFT JOIN _pick p ON p.lead_id = b.lead_id;
  CREATE INDEX ON _lead_res (ident);

  CREATE TEMP TABLE _first ON COMMIT DROP AS
  SELECT DISTINCT ON (ident) ident, src, chan, conf, layer
    FROM _lead_res ORDER BY ident, (layer = 'none'), at NULLS LAST, lead_id;
  CREATE INDEX ON _first (ident);

  CREATE TEMP TABLE _target ON COMMIT DROP AS
  SELECT r.lead_id, f.src, f.chan, f.conf, f.layer,
         row_number() OVER (ORDER BY r.lead_id) AS rn
    FROM _lead_res r JOIN _first f ON f.ident = r.ident;
  CREATE INDEX ON _target (rn);

  SELECT max(rn) INTO maxrn FROM _target;
  WHILE lo < coalesce(maxrn, 0) LOOP
    UPDATE public.leads l
       SET unified_source = t.src, unified_channel = t.chan,
           unified_confidence = t.conf, resolution_layer = t.layer
      FROM _target t
     WHERE t.rn > lo AND t.rn <= lo + 20000
       AND l.lead_id = t.lead_id
       AND (l.unified_source IS DISTINCT FROM t.src
         OR l.unified_channel IS DISTINCT FROM t.chan
         OR l.unified_confidence IS DISTINCT FROM t.conf
         OR l.resolution_layer IS DISTINCT FROM t.layer);
    GET DIAGNOSTICS hit = ROW_COUNT;
    n := n + hit;
    lo := lo + 20000;
  END LOOP;
  RETURN n;
END;
$fn$;

REVOKE ALL ON FUNCTION public.refresh_unified_source() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_unified_source() TO service_role;
