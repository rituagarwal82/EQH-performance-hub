-- New agency Parami (PRM). Its label is prepared before its first lead so the
-- first one lands in the right place; nothing renders until it has data.
CREATE OR REPLACE FUNCTION public.meta_agency_label(p_ad_entity_ref text, p_campaign text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH acct AS (
    SELECT coalesce(e.agency_code, a.agency_code) AS ag, a.account_id, a.name
      FROM public.ad_entities e
      LEFT JOIN public.ad_accounts a ON a.account_id = e.account_id
     WHERE e.entity_id = p_ad_entity_ref
     LIMIT 1
  ), camp AS (
    SELECT coalesce(e.agency_code, a.agency_code) AS ag, a.account_id, a.name
      FROM public.ad_entities e
      LEFT JOIN public.ad_accounts a ON a.account_id = e.account_id
     WHERE p_campaign IS NOT NULL
       AND e.level = 'campaign'
       AND lower(e.name) = lower(btrim(p_campaign))
     LIMIT 1
  ), pick AS (
    SELECT * FROM acct
    UNION ALL SELECT * FROM camp WHERE NOT EXISTS (SELECT 1 FROM acct)
    UNION ALL
    SELECT CASE WHEN lower(btrim(p_campaign)) LIKE 'sd%'    THEN 'SD'
                WHEN lower(btrim(p_campaign)) LIKE 'japan%' THEN 'SD'
                WHEN lower(btrim(p_campaign)) LIKE 'rj%'    THEN 'RJ'
                WHEN lower(btrim(p_campaign)) LIKE 'prm%'   THEN 'PRM' END, NULL, NULL
     WHERE NOT EXISTS (SELECT 1 FROM acct) AND NOT EXISTS (SELECT 1 FROM camp)
  )
  SELECT CASE
           WHEN ag = 'SD' THEN 'Sabhi Digital – Meta ads'
           WHEN ag = 'RJ' THEN 'Rajdeep (in-house) – Meta ads'
           WHEN ag = 'SX' THEN 'ScaleX – Meta ads'
           WHEN ag = 'PRM' THEN 'Parami – Meta ads'
           WHEN ag IS NULL AND account_id IS NOT NULL
             THEN 'Meta ads – ' || coalesce(name, 'unlabelled account ' || right(account_id, 4))
           ELSE 'Meta ads – account unknown'
         END
    FROM pick LIMIT 1
$function$;

-- The agency report resolves spend for Parami the moment its account syncs.
CREATE OR REPLACE FUNCTION public.agency_channel_code(p_channel text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE p_channel
    WHEN 'Sabhi Digital – Meta ads' THEN 'SD'
    WHEN 'Rajdeep (in-house) – Meta ads' THEN 'RJ'
    WHEN 'ScaleX (agency, closed)' THEN 'SX'
    WHEN 'Parami – Meta ads' THEN 'PRM'
    ELSE NULL END
$$;