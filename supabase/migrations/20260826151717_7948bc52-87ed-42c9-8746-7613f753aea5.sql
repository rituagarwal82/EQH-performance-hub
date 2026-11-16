CREATE OR REPLACE FUNCTION public.upsert_daily_metrics(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  WITH incoming AS (
    SELECT
      (r->>'date')::date AS date,
      r->>'account_id' AS account_id,
      NULLIF(r->>'entity_id', '') AS entity_id,
      r->>'level' AS level,
      NULLIF(r->>'placement', '') AS placement,
      COALESCE((r->>'spend')::numeric, 0) AS spend,
      COALESCE((r->>'impressions')::bigint, 0) AS impressions,
      COALESCE((r->>'link_clicks')::int, 0) AS link_clicks,
      COALESCE((r->>'landing_page_views')::int, 0) AS landing_page_views,
      COALESCE((r->>'leads')::int, 0) AS leads,
      COALESCE((r->>'purchases')::int, 0) AS purchases
    FROM jsonb_array_elements(p_rows) AS r
  ), collapsed AS (
    -- Meta can return the same (date, entity, level, placement) more than once
    -- in a single response. Combine them here: two rows with the same key in
    -- one statement would abort the whole upsert.
    SELECT
      date, account_id, entity_id, level, placement,
      SUM(spend) AS spend,
      SUM(impressions) AS impressions,
      SUM(link_clicks) AS link_clicks,
      SUM(landing_page_views) AS landing_page_views,
      SUM(leads) AS leads,
      SUM(purchases) AS purchases
    FROM incoming
    GROUP BY date, account_id, entity_id, level, placement
  ), upserted AS (
    INSERT INTO public.daily_metrics
      (date, account_id, entity_id, level, placement, spend, impressions,
       link_clicks, landing_page_views, leads, purchases, synced_at)
    SELECT date, account_id, entity_id, level, placement, spend, impressions,
           link_clicks, landing_page_views, leads, purchases, now()
    FROM collapsed
    ON CONFLICT (date, account_id, COALESCE(entity_id, ''), level, COALESCE(placement, ''))
    DO UPDATE SET
      spend = EXCLUDED.spend,
      impressions = EXCLUDED.impressions,
      link_clicks = EXCLUDED.link_clicks,
      landing_page_views = EXCLUDED.landing_page_views,
      leads = EXCLUDED.leads,
      purchases = EXCLUDED.purchases,
      synced_at = now()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.upsert_daily_metrics(jsonb) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.upsert_daily_metrics(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_ad_entities(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  WITH incoming AS (
    SELECT
      r->>'entity_id' AS entity_id, r->>'level' AS level, r->>'account_id' AS account_id,
      NULLIF(r->>'parent_id', '') AS parent_id, r->>'name' AS name, r->>'status' AS status,
      NULLIF(r->>'agency_code', '') AS agency_code,
      row_number() OVER (PARTITION BY r->>'entity_id' ORDER BY r->>'level') AS rn
    FROM jsonb_array_elements(p_rows) AS r
  ), upserted AS (
    INSERT INTO public.ad_entities (entity_id, level, account_id, parent_id, name, status, agency_code, updated_at)
    SELECT entity_id, level, account_id, parent_id, name, status, agency_code, now()
    FROM incoming WHERE rn = 1
    ON CONFLICT (entity_id) DO UPDATE SET
      level = EXCLUDED.level,
      account_id = EXCLUDED.account_id,
      parent_id = EXCLUDED.parent_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status,
      agency_code = EXCLUDED.agency_code,
      updated_at = now()
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM upserted;
  RETURN v_count;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.upsert_ad_entities(jsonb) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.upsert_ad_entities(jsonb) TO service_role;