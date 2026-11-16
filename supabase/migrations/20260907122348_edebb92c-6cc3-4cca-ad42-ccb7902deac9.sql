CREATE OR REPLACE VIEW public.lead_attribution
WITH (security_invoker = true) AS
 SELECT DISTINCT ON (l.email_key) l.email_key,
    l.captured_at,
    l.utm_source,
    l.utm_campaign,
    l.utm_medium,
    CASE
      WHEN lower(btrim(COALESCE(l.utm_source, ''::text))) = ANY (ARRAY['google'::text,'youtube'::text])
        THEN CASE WHEN COALESCE(l.gclid, '') <> '' THEN 'google' ELSE 'organic_search' END
      WHEN l.ad_id IS NOT NULL OR l.ad_account_id IS NOT NULL THEN 'meta'
      ELSE COALESCE(m.platform, NULLIF(l.platform, ''::text), 'unknown'::text)
    END AS platform,
    l.ad_account_id,
    l.campaign_id,
    l.ad_id,
    l.agency_code,
    (NOT l.is_import OR l.webinar_date IS NOT NULL AND (EXISTS ( SELECT 1
           FROM unnest(l.tags) t(t)
          WHERE lower(t.t) = 'registered'::text)))
    AND CASE
      WHEN lower(btrim(COALESCE(l.utm_source, ''::text))) = ANY (ARRAY['google'::text,'youtube'::text])
        THEN COALESCE(l.gclid, '') <> ''
      ELSE (COALESCE(m.is_paid, false) OR l.ad_id IS NOT NULL OR l.campaign_id IS NOT NULL
            OR (lower(COALESCE(l.utm_medium, ''::text)) = ANY (ARRAY['cpc'::text,'paid'::text,'ppc'::text,'paid_social'::text])))
    END AS is_paid,
    l.is_import
   FROM leads l
     LEFT JOIN utm_source_map m ON m.raw = lower(btrim(COALESCE(l.utm_source, ''::text)))
  WHERE l.email_key IS NOT NULL AND l.email_key <> ''::text
  ORDER BY l.email_key, l.captured_at;