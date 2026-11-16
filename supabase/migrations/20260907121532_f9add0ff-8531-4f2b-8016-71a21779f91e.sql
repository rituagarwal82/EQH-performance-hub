UPDATE public.utm_source_map
   SET is_paid = false, platform = 'organic_search',
       note = 'Owner confirmed 2026-09-07: no Google Ads are running and none of the 3,974 google/youtube leads carry a Google click id. Treated as organic search. A lead arriving WITH a click id is classified as paid Google automatically.',
       updated_at = now()
 WHERE raw IN ('google','youtube');

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
      ELSE COALESCE(NULLIF(l.platform, ''::text), m.platform, 'unknown'::text)
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

CREATE OR REPLACE FUNCTION public.lead_is_paid(p_email text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (NOT l.is_import
          OR (l.webinar_date IS NOT NULL
              AND EXISTS (SELECT 1 FROM unnest(l.tags) t WHERE lower(t) = 'registered')))
     AND CASE
           WHEN lower(btrim(COALESCE(l.utm_source,''))) IN ('google','youtube')
             THEN COALESCE(l.gclid,'') <> ''
           ELSE (COALESCE(m.is_paid, false)
                 OR l.ad_id IS NOT NULL
                 OR l.campaign_id IS NOT NULL
                 OR lower(COALESCE(l.utm_medium,'')) = ANY (ARRAY['cpc','paid','ppc','paid_social']))
         END
  FROM public.leads l
  LEFT JOIN public.utm_source_map m ON m.raw = lower(btrim(COALESCE(l.utm_source,'')))
  WHERE l.email_key = p_email AND p_email IS NOT NULL AND p_email <> ''
  ORDER BY l.captured_at
  LIMIT 1
$function$;

INSERT INTO public.rule_changes (rule_key, what_changed, old_rule, new_rule, reason, confirmed_by, affects, evidence)
VALUES ('google_traffic_class',
 'Leads tagged google/youtube are organic search, not paid, unless they carry a Google Ads click id.',
 'utm_source google and youtube mapped to paid Google traffic.',
 'google/youtube with no click id map to organic search and are not paid; with a click id they map to paid Google.',
 'Owner confirmed Google Ads is stopped. None of the 3,974 google/youtube leads carry a click id, and August ones sit under two stale campaign tags (DG_Free_18May, DG Free 1July NLP).',
 'owner', ARRAY['paid_leads','cost_per_lead','cost_per_sale','paid_front_end_roas'],
 '{"google_leads_total":3974,"with_gclid":0,"august_leads":442,"august_sales_reclassified":15}'::jsonb);