-- 1. phone normaliser -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.norm_phone(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  WITH s AS (SELECT regexp_replace(coalesce(p,''), '\.0+$', '') AS t),
       d AS (SELECT regexp_replace(t, '\D', '', 'g') AS t FROM s),
       z AS (SELECT CASE WHEN length(t) > 10 THEN right(t,10) ELSE t END AS t FROM d)
  SELECT CASE WHEN t ~ '^[6-9][0-9]{9}$' THEN t ELSE NULL END FROM z
$$;

-- 2. leads: phone key + first-touch columns ---------------------------------
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS phone_key text,
  ADD COLUMN IF NOT EXISTS first_touch_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_touch_utm_source text,
  ADD COLUMN IF NOT EXISTS first_touch_utm_medium text,
  ADD COLUMN IF NOT EXISTS first_touch_utm_campaign text,
  ADD COLUMN IF NOT EXISTS first_touch_utm_content text,
  ADD COLUMN IF NOT EXISTS first_touch_campaign_id text,
  ADD COLUMN IF NOT EXISTS first_touch_adset_id text,
  ADD COLUMN IF NOT EXISTS first_touch_ad_id text,
  ADD COLUMN IF NOT EXISTS first_touch_agency_code text;

UPDATE public.leads SET
  phone_key = public.norm_phone(phone),
  first_touch_at = coalesce(first_touch_at, captured_at),
  first_touch_utm_source = coalesce(first_touch_utm_source, utm_source),
  first_touch_utm_medium = coalesce(first_touch_utm_medium, utm_medium),
  first_touch_utm_campaign = coalesce(first_touch_utm_campaign, utm_campaign),
  first_touch_utm_content = coalesce(first_touch_utm_content, utm_content),
  first_touch_campaign_id = coalesce(first_touch_campaign_id, campaign_id),
  first_touch_adset_id = coalesce(first_touch_adset_id, adset_id),
  first_touch_ad_id = coalesce(first_touch_ad_id, ad_id),
  first_touch_agency_code = coalesce(first_touch_agency_code, agency_code)
WHERE phone_key IS DISTINCT FROM public.norm_phone(phone) OR first_touch_at IS NULL;

CREATE INDEX IF NOT EXISTS leads_phone_key_idx ON public.leads (phone_key) WHERE phone_key IS NOT NULL;

-- 3. attribution change log --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.attribution_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id text NOT NULL,
  email_key text,
  field text NOT NULL,
  old_value text,
  attempted_value text,
  source_system text NOT NULL DEFAULT 'ghl',
  observed_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.attribution_changes TO authenticated;
GRANT ALL ON public.attribution_changes TO service_role;
ALTER TABLE public.attribution_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "attribution_changes readable" ON public.attribution_changes
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "attribution_changes service writes" ON public.attribution_changes
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS attribution_changes_lead_idx ON public.attribution_changes (lead_id, observed_at DESC);

-- 4. upsert_leads: first-touch preserving ------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_leads(p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
declare n integer;
begin
  create temp table _src on commit drop as
  select
      r->>'lead_id' as lead_id,
      coalesce(r->>'source_system','ghl') as source_system,
      nullif(r->>'email_raw','') as email_raw,
      nullif(lower(btrim(r->>'email_key')),'') as email_key,
      nullif(r->>'phone','') as phone,
      nullif(r->>'name','') as name,
      nullif(r->>'captured_at','')::timestamptz as captured_at,
      nullif(r->>'registered_at','')::timestamptz as registered_at,
      case when lower(btrim(coalesce(r->>'utm_source',''))) = 'source'
           then null else nullif(r->>'utm_source','') end as utm_source,
      (coalesce((r->>'is_import')::boolean, false)
        or lower(btrim(coalesce(r->>'utm_source',''))) = 'source') as is_import,
      nullif(r->>'utm_medium','') as utm_medium,
      nullif(r->>'utm_campaign','') as utm_campaign,
      nullif(r->>'utm_content','') as utm_content,
      nullif(r->>'utm_term','') as utm_term,
      nullif(r->>'utm_placement','') as utm_placement,
      nullif(r->>'campaign_id','') as campaign_id,
      nullif(r->>'adset_id','') as adset_id,
      nullif(r->>'ad_id','') as ad_id,
      nullif(r->>'fbclid','') as fbclid,
      nullif(r->>'gclid','') as gclid,
      nullif(r->>'fbc','') as fbc,
      nullif(r->>'fbp','') as fbp,
      nullif(r->>'landing_page','') as landing_page,
      nullif(r->>'source_platform','') as source_platform,
      nullif(r->>'platform','') as platform,
      coalesce((r->>'is_registered')::boolean, false) as is_registered,
      coalesce(
        (select array_agg(t) from jsonb_array_elements_text(coalesce(r->'tags','[]'::jsonb)) t),
        '{}'::text[]
      ) as tags,
      nullif(r->>'webinar_date','') as webinar_date,
      nullif(r->>'webinar_time','') as webinar_time,
      nullif(r->>'webinar_tag','') as webinar_tag,
      r->'raw' as raw
    from jsonb_array_elements(p_rows) r;

  -- record every attempted overwrite of a non-null attribution value
  insert into public.attribution_changes (lead_id, email_key, field, old_value, attempted_value, source_system)
  select s.lead_id, l.email_key, f.field, f.old_value, f.new_value, s.source_system
  from _src s
  join public.leads l on l.lead_id = s.lead_id
  cross join lateral (values
    ('utm_source', l.utm_source, s.utm_source),
    ('utm_medium', l.utm_medium, s.utm_medium),
    ('utm_campaign', l.utm_campaign, s.utm_campaign),
    ('utm_content', l.utm_content, s.utm_content),
    ('campaign_id', l.campaign_id, s.campaign_id),
    ('adset_id', l.adset_id, s.adset_id),
    ('ad_id', l.ad_id, s.ad_id)
  ) as f(field, old_value, new_value)
  where f.old_value is not null and f.new_value is not null and f.old_value <> f.new_value;

  with norm as (
    select s.*,
      public.agency_code_for(s.utm_source) as agency_code,
      (s.is_registered
       and (not s.is_import
            or (s.webinar_date is not null
                and exists (select 1 from unnest(s.tags) t where lower(t) = 'registered')))
      ) as is_registered_eff
    from _src s
  ),
  ins as (
    insert into public.leads as l (
      lead_id, source_system, email_raw, email_key, phone, phone_key, name,
      captured_at, registered_at, business_date,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_placement,
      campaign_id, adset_id, ad_id, fbclid, gclid, fbc, fbp,
      landing_page, source_platform, platform, is_registered, is_import, tags,
      webinar_date, webinar_time, webinar_tag, agency_code, raw, synced_at,
      first_touch_at, first_touch_utm_source, first_touch_utm_medium, first_touch_utm_campaign,
      first_touch_utm_content, first_touch_campaign_id, first_touch_adset_id,
      first_touch_ad_id, first_touch_agency_code
    )
    select
      s.lead_id, s.source_system, s.email_raw, s.email_key, s.phone, public.norm_phone(s.phone), s.name,
      s.captured_at, s.registered_at,
      public.business_date(coalesce(s.registered_at, s.captured_at)),
      s.utm_source, s.utm_medium, s.utm_campaign, s.utm_content, s.utm_term, s.utm_placement,
      s.campaign_id, s.adset_id, s.ad_id, s.fbclid, s.gclid, s.fbc, s.fbp,
      s.landing_page, s.source_platform, s.platform, s.is_registered_eff, s.is_import, s.tags,
      s.webinar_date, s.webinar_time, s.webinar_tag, s.agency_code, s.raw, now(),
      s.captured_at, s.utm_source, s.utm_medium, s.utm_campaign,
      s.utm_content, s.campaign_id, s.adset_id, s.ad_id, s.agency_code
    from norm s
    where s.lead_id is not null
    on conflict (lead_id) do update set
      source_system = excluded.source_system,
      email_raw = coalesce(l.email_raw, excluded.email_raw),
      email_key = coalesce(l.email_key, excluded.email_key),
      phone = coalesce(l.phone, excluded.phone),
      phone_key = coalesce(l.phone_key, excluded.phone_key),
      name = coalesce(excluded.name, l.name),
      -- first touch wins: never move the capture time forward
      captured_at = least(coalesce(l.captured_at, excluded.captured_at), coalesce(excluded.captured_at, l.captured_at)),
      registered_at = least(coalesce(l.registered_at, excluded.registered_at), coalesce(excluded.registered_at, l.registered_at)),
      business_date = least(coalesce(l.business_date, excluded.business_date), coalesce(excluded.business_date, l.business_date)),
      -- attribution is permanent: a non-null value is never replaced
      utm_source = coalesce(l.utm_source, excluded.utm_source),
      utm_medium = coalesce(l.utm_medium, excluded.utm_medium),
      utm_campaign = coalesce(l.utm_campaign, excluded.utm_campaign),
      utm_content = coalesce(l.utm_content, excluded.utm_content),
      utm_term = coalesce(l.utm_term, excluded.utm_term),
      utm_placement = coalesce(l.utm_placement, excluded.utm_placement),
      campaign_id = coalesce(l.campaign_id, excluded.campaign_id),
      adset_id = coalesce(l.adset_id, excluded.adset_id),
      ad_id = coalesce(l.ad_id, excluded.ad_id),
      fbclid = coalesce(l.fbclid, excluded.fbclid),
      gclid = coalesce(l.gclid, excluded.gclid),
      fbc = coalesce(l.fbc, excluded.fbc),
      fbp = coalesce(l.fbp, excluded.fbp),
      landing_page = coalesce(l.landing_page, excluded.landing_page),
      source_platform = coalesce(l.source_platform, excluded.source_platform),
      platform = coalesce(l.platform, excluded.platform),
      agency_code = coalesce(l.agency_code, excluded.agency_code),
      first_touch_at = least(coalesce(l.first_touch_at, excluded.first_touch_at), coalesce(excluded.first_touch_at, l.first_touch_at)),
      first_touch_utm_source = coalesce(l.first_touch_utm_source, excluded.first_touch_utm_source),
      first_touch_utm_medium = coalesce(l.first_touch_utm_medium, excluded.first_touch_utm_medium),
      first_touch_utm_campaign = coalesce(l.first_touch_utm_campaign, excluded.first_touch_utm_campaign),
      first_touch_utm_content = coalesce(l.first_touch_utm_content, excluded.first_touch_utm_content),
      first_touch_campaign_id = coalesce(l.first_touch_campaign_id, excluded.first_touch_campaign_id),
      first_touch_adset_id = coalesce(l.first_touch_adset_id, excluded.first_touch_adset_id),
      first_touch_ad_id = coalesce(l.first_touch_ad_id, excluded.first_touch_ad_id),
      first_touch_agency_code = coalesce(l.first_touch_agency_code, excluded.first_touch_agency_code),
      -- state fields still track the source of truth
      is_registered = l.is_registered or excluded.is_registered,
      is_import = l.is_import and excluded.is_import,
      tags = excluded.tags,
      webinar_date = coalesce(excluded.webinar_date, l.webinar_date),
      webinar_time = coalesce(excluded.webinar_time, l.webinar_time),
      webinar_tag = coalesce(excluded.webinar_tag, l.webinar_tag),
      raw = excluded.raw,
      synced_at = now()
    returning 1
  )
  select count(*)::int into n from ins;
  return n;
end
$function$;

-- 5. buyer phones and the email-primary / phone-secondary link ----------------
CREATE OR REPLACE VIEW public.buyer_phones AS
  SELECT DISTINCT lower(btrim(email)) AS email_key, public.norm_phone(phone) AS phone_key
  FROM (
    SELECT buyer_email AS email, buyer_phone AS phone FROM public.tm_payments
    UNION ALL
    SELECT buyer_email, buyer_phone FROM public.tm_enrolments
  ) s
  WHERE nullif(btrim(coalesce(email,'')),'') IS NOT NULL
    AND public.norm_phone(phone) IS NOT NULL;

CREATE OR REPLACE VIEW public.buyer_phone_candidates AS
  WITH buyers AS (
    SELECT DISTINCT i.email_key FROM public.ledger_inflow i
    WHERE i.email_key IS NOT NULL AND i.email_key <> ''
      AND NOT EXISTS (SELECT 1 FROM public.lead_attribution a WHERE a.email_key = i.email_key)
  )
  SELECT b.email_key, l.email_key AS lead_email_key, bp.phone_key
  FROM buyers b
  JOIN public.buyer_phones bp ON bp.email_key = b.email_key
  JOIN public.leads l ON l.phone_key = bp.phone_key
  WHERE l.email_key IS NOT NULL AND l.email_key <> '' AND l.email_key <> b.email_key;

CREATE OR REPLACE VIEW public.buyer_phone_conflicts AS
  SELECT email_key, count(DISTINCT lead_email_key)::bigint AS candidates,
         string_agg(DISTINCT lead_email_key, ', ') AS lead_emails
  FROM public.buyer_phone_candidates
  GROUP BY email_key
  HAVING count(DISTINCT lead_email_key) > 1;

CREATE OR REPLACE VIEW public.buyer_lead_link AS
  SELECT i.email_key, i.email_key AS lead_email_key, 'email'::text AS match_basis
  FROM (SELECT DISTINCT email_key FROM public.ledger_inflow WHERE email_key IS NOT NULL AND email_key <> '') i
  JOIN public.lead_attribution a ON a.email_key = i.email_key
  UNION ALL
  SELECT c.email_key, min(c.lead_email_key), 'phone'::text
  FROM public.buyer_phone_candidates c
  GROUP BY c.email_key
  HAVING count(DISTINCT c.lead_email_key) = 1;

GRANT SELECT ON public.buyer_phones, public.buyer_phone_candidates,
                public.buyer_phone_conflicts, public.buyer_lead_link TO authenticated, service_role;

-- 6. ledger functions now resolve through the link ---------------------------
CREATE OR REPLACE FUNCTION public.ledger_attribution_buckets(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER'::text)
 RETURNS TABLE(bucket text, buyers bigint, sales bigint, collected numeric)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH b AS (
    SELECT i.email_key,
           SUM(CASE WHEN i.is_new_sale THEN 1 ELSE 0 END)::bigint AS sales,
           SUM(i.amount_received)::numeric AS collected
    FROM public.ledger_inflow i
    WHERE i.product_tier = p_tier AND i.business_date BETWEEN p_start AND p_end
    GROUP BY i.email_key
  )
  SELECT
    CASE WHEN a.email_key IS NULL THEN 'NO_LEAD_RECORD'
         WHEN a.is_paid THEN 'PAID'
         ELSE 'LEAD_NOT_PAID' END,
    COUNT(*)::bigint,
    SUM(b.sales)::bigint,
    SUM(b.collected)::numeric
  FROM b
  LEFT JOIN public.buyer_lead_link k ON k.email_key = b.email_key
  LEFT JOIN public.lead_attribution a ON a.email_key = k.lead_email_key
  GROUP BY 1
$function$;

CREATE OR REPLACE FUNCTION public.ledger_lead_coverage(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER'::text)
 RETURNS TABLE(buyers bigint, matched bigint, unmatched bigint, coverage_pct numeric, with_campaign bigint, campaign_pct numeric, leads_total bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH b AS (
    SELECT DISTINCT i.email_key
    FROM public.ledger_inflow i
    WHERE i.product_tier = p_tier AND i.business_date BETWEEN p_start AND p_end
      AND i.email_key IS NOT NULL AND i.email_key <> ''
  ), j AS (
    SELECT b.email_key, a.email_key IS NOT NULL AS matched,
           NULLIF(btrim(COALESCE(a.utm_campaign, '')), '') IS NOT NULL AS has_campaign
    FROM b
    LEFT JOIN public.buyer_lead_link k ON k.email_key = b.email_key
    LEFT JOIN public.lead_attribution a ON a.email_key = k.lead_email_key
  )
  SELECT COUNT(*)::bigint,
         COUNT(*) FILTER (WHERE matched)::bigint,
         COUNT(*) FILTER (WHERE NOT matched)::bigint,
         CASE WHEN COUNT(*) = 0 THEN NULL ELSE round(100.0 * COUNT(*) FILTER (WHERE matched) / COUNT(*), 1) END,
         COUNT(*) FILTER (WHERE has_campaign)::bigint,
         CASE WHEN COUNT(*) = 0 THEN NULL ELSE round(100.0 * COUNT(*) FILTER (WHERE has_campaign) / COUNT(*), 1) END,
         (SELECT COUNT(*) FROM public.leads)::bigint
  FROM j
$function$;

DROP FUNCTION IF EXISTS public.ledger_unmatched_buyers(date,date,text,integer);
CREATE OR REPLACE FUNCTION public.ledger_unmatched_buyers(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER'::text, p_limit integer DEFAULT 1000)
 RETURNS TABLE(email_key text, email_raw text, payer_name text, first_date date, last_date date, sales bigint, collected numeric, rows_count bigint, receipt_source text, predates_lead_history boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT i.email_key,
         min(i.email_raw),
         min(i.payer_name),
         min(i.business_date),
         max(i.business_date),
         SUM(CASE WHEN i.is_new_sale THEN 1 ELSE 0 END)::bigint,
         SUM(i.amount_received)::numeric,
         count(*)::bigint,
         min(i.receipt_source),
         (max(i.business_date) < (SELECT min(business_date) FROM public.leads)) AS predates
  FROM public.ledger_inflow i
  WHERE i.product_tier = p_tier
    AND i.business_date BETWEEN p_start AND p_end
    AND NOT EXISTS (SELECT 1 FROM public.buyer_lead_link k WHERE k.email_key = i.email_key)
  GROUP BY i.email_key
  ORDER BY SUM(i.amount_received) DESC
  LIMIT greatest(1, least(p_limit, 5000))
$function$;

CREATE OR REPLACE FUNCTION public.ledger_unmatched_summary(p_start date, p_end date, p_tier text DEFAULT 'L1_SILVER'::text)
 RETURNS TABLE(total bigint, predating bigint, predating_pct numeric, lead_history_start date, phone_matched bigint, phone_conflicts bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  WITH h AS (SELECT min(business_date) AS start FROM public.leads),
  u AS (
    SELECT i.email_key, max(i.business_date) AS last_date
    FROM public.ledger_inflow i
    WHERE i.product_tier = p_tier AND i.business_date BETWEEN p_start AND p_end
      AND NOT EXISTS (SELECT 1 FROM public.buyer_lead_link k WHERE k.email_key = i.email_key)
    GROUP BY i.email_key
  )
  SELECT COUNT(*)::bigint,
         COUNT(*) FILTER (WHERE u.last_date < (SELECT start FROM h))::bigint,
         CASE WHEN COUNT(*) = 0 THEN NULL
              ELSE round(100.0 * COUNT(*) FILTER (WHERE u.last_date < (SELECT start FROM h)) / COUNT(*), 1) END,
         (SELECT start FROM h),
         (SELECT count(*)::bigint FROM public.buyer_lead_link WHERE match_basis = 'phone'),
         (SELECT count(*)::bigint FROM public.buyer_phone_conflicts)
  FROM u
$function$;

-- 7. backfill cursor settings -------------------------------------------------
INSERT INTO public.app_settings (key, value, description) VALUES
  ('ghl_backfill_cursor', '2023-01-01', 'Next month-window start for the full-history lead import'),
  ('ghl_backfill_status', 'idle', 'idle | running | done | paused'),
  ('ghl_backfill_note', '', 'Last message from the full-history lead import')
ON CONFLICT (key) DO NOTHING;