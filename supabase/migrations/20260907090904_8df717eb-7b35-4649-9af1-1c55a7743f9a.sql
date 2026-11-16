-- 1. OWNER-CONFIRMED ACCOUNT OWNERSHIP -------------------------------------
UPDATE public.ad_accounts SET agency_code = 'SD' WHERE account_id = '1249430309131428';
-- Owner lists this one as still unassigned; it must not sit inside SD's spend
-- basis on an unconfirmed marking. A review item asks the question.
UPDATE public.ad_accounts SET agency_code = NULL WHERE account_id = '1488704194840585';

-- 2. RULE CHANGE LOG --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rule_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key text NOT NULL,
  what_changed text NOT NULL,
  old_rule text,
  new_rule text NOT NULL,
  reason text NOT NULL,
  confirmed_by text NOT NULL,
  affects text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.rule_changes TO authenticated;
GRANT ALL ON public.rule_changes TO service_role;
ALTER TABLE public.rule_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rule changes are readable in the app"
  ON public.rule_changes FOR SELECT TO authenticated USING (true);
CREATE POLICY "the engine records rule changes"
  ON public.rule_changes FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE INDEX IF NOT EXISTS rule_changes_key_idx ON public.rule_changes (rule_key, created_at DESC);

-- 3. ONE DEFINITION OF WHICH TEAM A LEAD BELONGS TO -------------------------
-- Spend resolves a team through ad account ownership. Cash and leads must
-- resolve it the SAME way or a team's spend and its cash describe different
-- populations — the 48.84x incident, inverted: SD's whole ~99L basis against
-- the cash of the few hundred leads whose link code happened to carry _P/_PW.
CREATE OR REPLACE FUNCTION public.lead_agency_code(p_ad_ref text, p_utm_source text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_ad_ref IS NOT NULL AND EXISTS (SELECT 1 FROM public.ad_entities e WHERE e.entity_id = p_ad_ref)
      THEN (SELECT a.agency_code
              FROM public.ad_entities e
              JOIN public.ad_accounts a ON a.account_id = e.account_id
             WHERE e.entity_id = p_ad_ref)
    ELSE public.agency_code_for(p_utm_source)
  END
$$;

-- Re-derives every lead under that rule. Runs after ad references resolve,
-- because the ad reference is what the primary rule reads.
CREATE OR REPLACE FUNCTION public.refresh_lead_agency()
RETURNS TABLE(agency_code text, leads bigint, changed bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  CREATE TEMP TABLE _la ON COMMIT DROP AS
  SELECT l.lead_id,
         l.agency_code AS old_ac,
         CASE WHEN e.entity_id IS NOT NULL THEN a.agency_code
              ELSE public.agency_code_for(l.utm_source) END AS new_ac
    FROM public.leads l
    LEFT JOIN public.ad_entities e ON e.entity_id = l.ad_entity_ref
    LEFT JOIN public.ad_accounts a ON a.account_id = e.account_id;
  CREATE INDEX ON _la (lead_id);

  UPDATE public.leads l
     SET agency_code = t.new_ac
    FROM _la t
   WHERE t.lead_id = l.lead_id
     AND l.agency_code IS DISTINCT FROM t.new_ac;

  RETURN QUERY
  SELECT coalesce(t.new_ac, '(none)'),
         count(*)::bigint,
         count(*) FILTER (WHERE t.old_ac IS DISTINCT FROM t.new_ac)::bigint
    FROM _la t GROUP BY 1 ORDER BY 2 DESC;
END;
$$;

-- 4. NEW LEADS ARRIVE UNDER THE SAME RULE -----------------------------------
CREATE OR REPLACE FUNCTION public.upsert_leads(p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- ownership first, link-code suffix only when no ad resolves
      public.lead_agency_code(s.ad_id, s.utm_source) as agency_code,
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
      -- the derived team follows the rule, it is not sticky
      agency_code = coalesce(excluded.agency_code, l.agency_code),
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

-- 5. PERMANENT SYMMETRY INVARIANT -------------------------------------------
-- Hard failure whenever a team's cash/lead side resolves membership by a
-- different rule than its spend side. Second appearance of this defect class.
CREATE OR REPLACE FUNCTION public.inv_basis_symmetry_rows(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  out_rows jsonb := '[]'::jsonb;
  r record;
BEGIN
  FOR r IN
    WITH scope AS (
      SELECT l.lead_id,
             l.agency_code AS stored,
             CASE WHEN e.entity_id IS NOT NULL THEN a.agency_code
                  ELSE public.agency_code_for(l.utm_source) END AS owned
        FROM public.leads l
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
    out_rows := out_rows || jsonb_build_array(jsonb_build_object(
      'check_id','inv_basis_symmetry','checked_at',v_now,'for_date',p_end,
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
$$;

INSERT INTO public.proof_registry
  (check_id, family, label, plain, expected_noise, fp_budget_per_30d, enabled, ord, structural_note)
VALUES (
  'inv_basis_symmetry', 'invariant', 'Spend and cash agree on who a team is',
  'A team''s spend is decided by which ad accounts it runs. Its cash and leads must be decided the same way. If the two ever drift apart, every ratio for that team is comparing one team''s money with another team''s cost.',
  'none — this must never fire', 0, true, 20,
  'Second appearance of this defect class: the 48.84x overstatement, and the ~7x understatement that would have followed the Ritu Agarwal 2 ownership change.')
ON CONFLICT (check_id) DO UPDATE
  SET label = excluded.label, plain = excluded.plain, enabled = true,
      structural_note = excluded.structural_note, updated_at = now();