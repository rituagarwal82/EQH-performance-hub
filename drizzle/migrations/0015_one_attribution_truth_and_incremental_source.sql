-- 1. ONE TEAM TRUTH -----------------------------------------------------
-- Team membership for cash was still being read from lead_attribution
-- (leads.agency_code / utm guesswork) while everything else had moved to the
-- unified source. Two systems, two answers. These helpers make the unified
-- channel the only place a team comes from.
CREATE OR REPLACE FUNCTION public.channel_is_paid_media(p_channel text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT p_channel IS NOT NULL
     AND ( p_channel LIKE '%Meta ads%'
        OR p_channel LIKE '%Google Ads%'
        OR p_channel IN ('ScaleX (agency, closed)','Tushar (agency, closed)','Vlad (agency, closed)') )
$$;

-- The team that owns a paid channel. Sabhi's Google money is its own code
-- because Google spend never reaches us: it must never be treated as covered
-- by Sabhi's Meta spend.
CREATE OR REPLACE FUNCTION public.channel_team_code(p_channel text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE p_channel
    WHEN 'Sabhi Digital – Meta ads' THEN 'SD'
    WHEN 'Rajdeep (in-house) – Meta ads' THEN 'RJ'
    WHEN 'ScaleX – Meta ads' THEN 'SX'
    WHEN 'ScaleX (agency, closed)' THEN 'SX'
    WHEN 'Parami – Meta ads' THEN 'PRM'
    WHEN 'Sabhi Digital – Google Ads' THEN 'SD_GOOGLE'
    WHEN 'Tushar (agency, closed)' THEN 'TUSHAR'
    WHEN 'Vlad (agency, closed)' THEN 'VLAD'
    ELSE NULL END
$$;

-- Paid marker + owning team for a buyer, read from the unified source only.
CREATE OR REPLACE FUNCTION public.buyer_paid_team(p_email_key text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT u.unified_channel
    FROM public.lead_unified_source u
   WHERE p_email_key IS NOT NULL
     AND u.ident = p_email_key
     AND public.channel_is_paid_media(u.unified_channel)
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.ledger_paid_daily(p_start date, p_end date)
 RETURNS TABLE(business_date date, collected_all numeric, collected_new_sale numeric, collected_no_lead numeric, collected_instalment numeric, collected_paid_gross numeric, collected_paid_exgst numeric, rows_all bigint, rows_paid bigint, collected_unsynced_gross numeric, rows_unsynced bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
  WITH l AS (
    SELECT li.business_date, li.amount_received, li.revenue_recognized, li.counts_as_sale,
           EXISTS (SELECT 1 FROM public.leads x WHERE x.email_key = li.email_key) AS has_lead,
           public.buyer_paid_team(li.email_key) IS NOT NULL AS has_paid_marker,
           public.agency_spend_synced(
             public.channel_team_code(public.buyer_paid_team(li.email_key))) AS spend_synced
      FROM public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND li.email_key IS NOT NULL
    UNION ALL
    SELECT li.business_date, li.amount_received, li.revenue_recognized, li.counts_as_sale, false, false, false
      FROM public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND li.email_key IS NULL
  )
  SELECT l.business_date,
         coalesce(sum(l.amount_received), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.revenue_recognized), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.revenue_recognized AND NOT l.has_lead), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE NOT l.revenue_recognized), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.revenue_recognized AND l.has_paid_marker AND l.spend_synced), 0)::numeric,
         round(coalesce(sum(l.amount_received) FILTER (WHERE l.revenue_recognized AND l.has_paid_marker AND l.spend_synced), 0)::numeric / 1.18, 2),
         count(*)::bigint,
         count(*) FILTER (WHERE l.counts_as_sale AND l.has_paid_marker AND l.spend_synced)::bigint,
         coalesce(sum(l.amount_received) FILTER (WHERE l.revenue_recognized AND l.has_paid_marker AND NOT l.spend_synced), 0)::numeric,
         count(*) FILTER (WHERE l.counts_as_sale AND l.has_paid_marker AND NOT l.spend_synced)::bigint
    FROM l GROUP BY l.business_date ORDER BY l.business_date
$function$;

CREATE OR REPLACE FUNCTION public.spend_symmetry(p_start date, p_end date)
 RETURNS TABLE(excluded_cash numeric, excluded_rows bigint, teams text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH b AS (
    SELECT greatest(p_start, p_end - 60) AS s, p_end AS e
  ),
  pd AS (
    SELECT * FROM b, LATERAL public.ledger_paid_daily(b.s, b.e)
  ),
  k AS MATERIALIZED (
    SELECT DISTINCT li.email_key
      FROM b, public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER' AND li.revenue_recognized
       AND li.business_date BETWEEN b.s AND b.e
       AND li.email_key IS NOT NULL
  ),
  t AS MATERIALIZED (
    SELECT DISTINCT public.channel_team_code(public.buyer_paid_team(k.email_key)) AS ac
      FROM k
     WHERE public.buyer_paid_team(k.email_key) IS NOT NULL
  )
  SELECT coalesce(sum(pd.collected_unsynced_gross), 0)::numeric,
         coalesce(sum(pd.rows_unsynced), 0)::bigint,
         coalesce((SELECT array_agg(coalesce(t.ac,'UNASSIGNED') ORDER BY t.ac) FROM t
                    WHERE NOT public.agency_spend_synced(t.ac)), '{}'::text[])
    FROM pd
$function$;

-- I-BASIS now compares the unified source's team against the team that owns
-- the ad, instead of the old stored agency_code.
CREATE OR REPLACE FUNCTION public.inv_basis_symmetry_rows(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  out_rows jsonb := '[]'::jsonb;
  r record;
  v_id text;
BEGIN
  FOR r IN
    WITH scope AS (
      SELECT l.lead_id,
             public.channel_team_code(u.unified_channel) AS stored,
             CASE WHEN e.entity_id IS NOT NULL THEN a.agency_code
                  ELSE public.agency_code_for(l.utm_source) END AS owned
        FROM public.leads l
        LEFT JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
        LEFT JOIN public.ad_entities e ON e.entity_id = l.ad_entity_ref
        LEFT JOIN public.ad_accounts a ON a.account_id = e.account_id
       WHERE l.business_date BETWEEN p_start AND p_end
    )
    SELECT coalesce(s.stored, s.owned) AS team,
           count(*)::bigint AS n,
           count(*) FILTER (WHERE s.stored IS DISTINCT FROM s.owned)::bigint AS mismatched
      FROM scope s
     WHERE coalesce(s.stored, s.owned) IS NOT NULL
     GROUP BY 1
  LOOP
    v_id := CASE WHEN r.team IN ('SD','RJ','SX','PRM')
                 THEN 'inv_basis_symmetry_' || lower(r.team)
                 ELSE 'inv_basis_symmetry' END;
    out_rows := out_rows || jsonb_build_array(jsonb_build_object(
      'check_id', v_id, 'checked_at',v_now,'for_date',p_end,
      'primary_value', r.n - r.mismatched,
      'primary_source','Leads for team ' || r.team || ' whose team comes from the ad account that team owns',
      'witness_value', r.n,
      'witness_source','All leads counted against team ' || r.team,
      'divergence_pct', CASE WHEN r.n = 0 THEN 0 ELSE round(100.0 * r.mismatched / r.n, 2) END,
      'verdict', CASE WHEN r.mismatched = 0 THEN 'match' ELSE 'diverged' END,
      'note', CASE WHEN r.mismatched = 0
        THEN r.team || ': spend and cash both decide team membership by who owns the ad account. Same definition on both sides.'
        ELSE r.team || ': ' || r.mismatched || ' of ' || r.n ||
             ' leads are counted against a team that does not own the ad they came from. ' ||
             'Spend and cash are describing different populations — every ratio for this team is wrong until it is re-derived.' END));
  END LOOP;

  IF out_rows = '[]'::jsonb THEN
    out_rows := jsonb_build_array(jsonb_build_object(
      'check_id','inv_basis_symmetry','checked_at',v_now,'for_date',p_end,
      'primary_value', 0, 'primary_source','Leads carrying a team in this window',
      'witness_value', 0, 'witness_source','None to check',
      'divergence_pct', 0, 'verdict','match',
      'note','No lead in this window carries a team, so there is nothing that could disagree.'));
  END IF;

  RETURN out_rows;
END;
$function$;

-- 2. EVERY LEAD GETS A SOURCE DECISION ----------------------------------
CREATE OR REPLACE FUNCTION public.inv_source_decision_rows(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT count(*)::bigint AS n,
           count(*) FILTER (WHERE u.lead_id IS NULL)::bigint AS missing
      FROM public.leads l
      LEFT JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
     WHERE l.business_date BETWEEN p_start AND p_end
       AND coalesce(l.captured_at, l.synced_at) < now() - interval '2 hours'
  )
  SELECT jsonb_build_array(jsonb_build_object(
    'check_id','inv_source_decision','checked_at',now(),'for_date',p_end,
    'primary_value', s.n - s.missing,
    'primary_source','Leads older than 2 hours that carry a source decision',
    'witness_value', s.n,
    'witness_source','All leads older than 2 hours in this window',
    'divergence_pct', CASE WHEN s.n = 0 THEN 0 ELSE round(100.0 * s.missing / s.n, 2) END,
    'verdict', CASE WHEN s.missing = 0 THEN 'match' ELSE 'diverged' END,
    'note', CASE WHEN s.missing = 0
      THEN 'Every lead settled long enough to be resolved has a source decision.'
      ELSE s.missing || ' of ' || s.n || ' leads have no source decision at all. ' ||
           'Their sales show as "No lead record" and their team gets no credit until they are resolved.' END))
  FROM s
$function$;

-- Resolve the source for just the leads that need it: brand new ones, ones
-- that changed, and any that somehow never got a decision. Same rules as the
-- full rebuild — this is the full rebuild's body over a small slice.
CREATE OR REPLACE FUNCTION public.resolve_unified_source_incremental(p_window interval DEFAULT interval '3 days')
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
DECLARE n integer;
BEGIN
  CREATE TEMP TABLE _scope ON COMMIT DROP AS
    SELECT l.lead_id
      FROM public.leads l
      LEFT JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
     WHERE u.lead_id IS NULL
        OR l.synced_at > now() - p_window;
  CREATE INDEX ON _scope (lead_id);

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
      JOIN _scope sc ON sc.lead_id = l.lead_id
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
    CASE WHEN base.ch <> 'Meta ads' AND af.label IS NOT NULL THEN 'recovered from ad fields'
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

  -- First touch still governs: re-apply it for the people just touched.
  WITH idents AS (
    SELECT DISTINCT u.ident FROM public.lead_unified_source u
      JOIN _scope sc ON sc.lead_id = u.lead_id
  ), ranked AS (
    SELECT DISTINCT ON (u.ident) u.ident, u.unified_source, u.unified_channel,
           u.unified_confidence, u.resolution_layer, u.unified_tool
      FROM public.lead_unified_source u
      JOIN idents i ON i.ident = u.ident
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

  RETURN n;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.resolve_unified_source_incremental(interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.inv_source_decision_rows(date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.channel_is_paid_media(text) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.channel_team_code(text) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.buyer_paid_team(text) TO authenticated, service_role;

INSERT INTO public.proof_registry (check_id, family, label, plain, expected_noise, fp_budget_per_30d, tolerance_note, structural_note, enabled, ord)
VALUES ('inv_source_decision', 'invariant', 'Every lead has a source decision',
 'Every lead older than two hours must have a source decision. Without one the lead belongs to nobody: its sale reads "No lead record" and its team gets no credit.',
 'none — a lead with no decision is always a fault', 0,
 'Leads captured in the last two hours are excluded: they are still being resolved.',
 'Structural: the resolver now runs after every lead sync, so a gap here means the resolver did not run or failed.',
 true, 95)
ON CONFLICT (check_id) DO UPDATE SET label = excluded.label, plain = excluded.plain, enabled = true;