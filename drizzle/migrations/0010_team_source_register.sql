-- 1. The register itself. Raw values are kept; the normalised label is derived.
CREATE TABLE IF NOT EXISTS public.team_source_register (
  match_key text NOT NULL,
  entry_date date NOT NULL,
  student_name text,
  email_raw text,
  email_key text,
  alt_email_raw text,
  alt_email_key text,
  phone10 text,
  team_source_raw text,
  team_source_detail text,
  webinar_attended text,
  notes text,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_key, entry_date)
);

GRANT SELECT ON public.team_source_register TO authenticated;
GRANT ALL ON public.team_source_register TO service_role;
ALTER TABLE public.team_source_register ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team register readable by signed-in staff" ON public.team_source_register;
CREATE POLICY "team register readable by signed-in staff"
  ON public.team_source_register FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "team register managed by service role" ON public.team_source_register;
CREATE POLICY "team register managed by service role"
  ON public.team_source_register FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS team_source_register_email_idx ON public.team_source_register (email_key);
CREATE INDEX IF NOT EXISTS team_source_register_alt_email_idx ON public.team_source_register (alt_email_key);
CREATE INDEX IF NOT EXISTS team_source_register_phone_idx ON public.team_source_register (phone10);

-- 2. Three more of the owner's rulings, so the register's own spellings land
--    on the same labels as everything else.
CREATE OR REPLACE FUNCTION public.team_source_label(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  WITH v AS (SELECT lower(btrim(coalesce(p_raw,''))) AS s)
  SELECT CASE
    WHEN s = '' OR s LIKE '#n/a%' OR s = 'unknown' OR s = 'na' THEN NULL
    WHEN s = 'desdkit' THEN NULL
    WHEN s LIKE 'sidz%' THEN 'Collaboration: Coach Siddharth Rajshekhar'
    WHEN s LIKE 'technofunda%' THEN 'Collaboration: Coach Vivek Mashrani'
    WHEN s LIKE 'swetas%' THEN 'Collaboration: Coach Shweta Samota'
    WHEN s LIKE 'fwaieqh%' THEN 'Collaboration: Coach Avinash Mada'
    WHEN s LIKE 'badri%' THEN 'Collaboration: Coach Badri'
    WHEN s LIKE 'lead magnet%' THEN 'Own funnel: lead magnet'
    WHEN s LIKE '%/%' THEN NULL
    WHEN s LIKE 'sabhi%' OR s LIKE '%sabhi%' THEN 'Sabhi Digital – Meta ads'
    WHEN s IN ('sx','scalex','scale x') THEN 'ScaleX (agency, closed)'
    WHEN s LIKE 'rajdeep%' THEN 'Rajdeep (in-house) – Meta ads'
    WHEN s LIKE 'youtube%' THEN 'YouTube (organic)'
    WHEN s LIKE 'organic%' THEN 'Organic search'
    WHEN s LIKE 'gunjan%' THEN 'Podcast: Gunjan'
    WHEN s LIKE 'bhanu%' THEN 'Podcast: Bhanu'
    WHEN s LIKE 'vikaas%' OR s LIKE 'vikas%' THEN 'Podcast: Vikaas Naagru'
    WHEN s LIKE 'bharti%' THEN 'Podcast: Bharti'
    WHEN s LIKE 'tushar%' THEN 'Tushar (agency, closed)'
    WHEN s LIKE 'vlad%' THEN 'Vlad (agency, closed)'
    WHEN replace(replace(s, ',', '.'), '.', '') LIKE 'dr %shikha%' OR s LIKE 'dr%shikha%' THEN 'Team: Dr. Shikha'
    ELSE 'Team: ' || btrim(p_raw)
  END
  FROM v
$function$;

-- 3. One answer per person from the register: email, then alternate email,
--    then the last ten digits of the phone — and the phone only where it
--    points at exactly one person on both sides.
CREATE OR REPLACE FUNCTION public.team_register_person()
RETURNS TABLE(email_key text, label text, entry_date date, matched_by text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH reg AS (
    SELECT r.*, public.team_source_label(r.team_source_raw) AS lbl
      FROM public.team_source_register r
  ),
  by_email AS (
    SELECT r.email_key AS ek, r.lbl, r.entry_date, 'email'::text AS how
      FROM reg r WHERE r.email_key IS NOT NULL AND r.lbl IS NOT NULL
  ),
  by_alt AS (
    SELECT r.alt_email_key AS ek, r.lbl, r.entry_date, 'alt email'::text AS how
      FROM reg r WHERE r.alt_email_key IS NOT NULL AND r.lbl IS NOT NULL
  ),
  -- a phone that appears on more than one register row, or that more than one
  -- person in the lead system shares, is not evidence of anything
  phone_unique AS (
    SELECT r.phone10, min(r.lbl) AS lbl, min(r.entry_date) AS entry_date
      FROM reg r
     WHERE r.phone10 IS NOT NULL AND r.lbl IS NOT NULL AND r.email_key IS NULL
     GROUP BY r.phone10
    HAVING count(DISTINCT r.lbl) = 1
  ),
  lead_phone AS (
    SELECT right(public.norm_phone(l.phone), 10) AS p10, min(l.email_key) AS ek
      FROM public.leads l
     WHERE l.phone IS NOT NULL AND l.email_key IS NOT NULL
     GROUP BY 1
    HAVING count(DISTINCT l.email_key) = 1
  ),
  by_phone AS (
    SELECT lp.ek, pu.lbl, pu.entry_date, 'phone'::text AS how
      FROM phone_unique pu JOIN lead_phone lp ON lp.p10 = pu.phone10
  ),
  all_m AS (
    SELECT * FROM by_email UNION ALL SELECT * FROM by_alt UNION ALL SELECT * FROM by_phone
  )
  SELECT DISTINCT ON (ek) ek, lbl, entry_date, how
    FROM all_m
   WHERE ek IS NOT NULL
   ORDER BY ek, entry_date, how;
$function$;

-- 4. Precedence: hard tracking evidence > the ledger's own source column >
--    the register. The register never overwrites tracking; where it disagrees
--    at family level the pair goes to the review list instead.
CREATE OR REPLACE FUNCTION public.rebuild_sale_attribution()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE n bigint;
BEGIN
  CREATE TEMP TABLE _keys ON COMMIT DROP AS
  SELECT DISTINCT li.email_key
    FROM public.ledger_inflow li
   WHERE li.product_tier = 'L1_SILVER'
     AND li.email_key IS NOT NULL
     AND li.business_date IS NOT NULL
     AND (li.is_new_sale OR li.counts_as_sale);

  CREATE INDEX ON _keys (email_key);
  ANALYZE _keys;

  CREATE TEMP TABLE _ft ON COMMIT DROP AS
  SELECT DISTINCT ON (l.email_key) l.email_key, u.unified_source, u.unified_channel,
         u.unified_tool, u.unified_confidence, u.resolution_layer
    FROM public.leads l
    JOIN _keys k ON k.email_key = l.email_key
    JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
   ORDER BY l.email_key, l.captured_at NULLS LAST, l.lead_id;

  CREATE INDEX ON _ft (email_key);
  ANALYZE _ft;

  CREATE TEMP TABLE _reg ON COMMIT DROP AS
  SELECT p.email_key, p.label FROM public.team_register_person() p;
  CREATE INDEX ON _reg (email_key);
  ANALYZE _reg;

  DELETE FROM public.sale_attribution;

  INSERT INTO public.sale_attribution
    (row_hash, business_date, month, email_key, channel, source, tool,
     confidence, layer, cash, is_new_sale, counts_as_sale)
  SELECT r.row_hash, r.business_date, to_char(r.business_date,'YYYY-MM'), r.email_key,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN r.team ELSE r.ch END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN r.team ELSE r.src END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN NULL ELSE r.tl END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN 'team-confirmed' ELSE r.conf END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN r.team_layer ELSE r.layer END,
         coalesce(r.amount_received,0), r.is_new_sale, r.counts_as_sale
    FROM (
      SELECT li.row_hash, li.business_date, li.email_key,
             coalesce(ft.unified_channel,'No lead record') AS ch,
             coalesce(ft.unified_source,'No lead record') AS src,
             ft.unified_tool AS tl,
             coalesce(ft.unified_confidence,'unknown') AS conf,
             ft.resolution_layer AS layer,
             coalesce(public.team_source_label(li.source_of_student_raw), rg.label) AS team,
             CASE WHEN public.team_source_label(li.source_of_student_raw) IS NOT NULL
                  THEN 'ledger_team_source' ELSE 'team_register' END AS team_layer,
             public.source_pair_class(
               coalesce(ft.unified_channel,'No lead record'),
               coalesce(public.team_source_label(li.source_of_student_raw), rg.label),
               (ft.unified_channel LIKE '%Meta ads%' AND ft.unified_channel NOT LIKE '%unknown%'
                AND ft.unified_confidence IN ('confirmed','recovered from ad fields'))
             ) AS cls,
             li.is_new_sale, li.counts_as_sale, li.amount_received
        FROM public.ledger_inflow li
        LEFT JOIN _ft ft ON ft.email_key = li.email_key
        LEFT JOIN _reg rg ON rg.email_key = li.email_key
       WHERE li.product_tier = 'L1_SILVER'
         AND li.business_date IS NOT NULL
         AND (li.is_new_sale OR li.counts_as_sale)
    ) r;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- 5. The review list sees the register too, through the same family-level test.
CREATE OR REPLACE FUNCTION public.sale_source_disagreements(p_start date, p_end date)
RETURNS TABLE(sale_id text, business_date date, email text, tracking_answer text, team_answer text, evidence text, cash numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH ft AS (
    SELECT DISTINCT ON (l.email_key) l.email_key, u.unified_channel, u.unified_confidence, u.resolution_layer
      FROM public.leads l
      JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
     WHERE l.email_key IS NOT NULL
     ORDER BY l.email_key, l.captured_at NULLS LAST, l.lead_id
  ),
  reg AS (SELECT * FROM public.team_register_person()),
  pairs AS (
    SELECT li.row_hash, li.business_date, li.email_key,
           ft.unified_channel AS track,
           coalesce(public.team_source_label(li.source_of_student_raw), reg.label) AS team,
           ft.resolution_layer || ' · ' || ft.unified_confidence
             || CASE WHEN public.team_source_label(li.source_of_student_raw) IS NULL AND reg.label IS NOT NULL
                     THEN ' · team answer from register' ELSE '' END AS evidence,
           li.amount_received,
           (ft.unified_channel LIKE '%Meta ads%' AND ft.unified_channel NOT LIKE '%unknown%'
            AND ft.unified_confidence IN ('confirmed','recovered from ad fields')) AS hard_ad
      FROM public.ledger_inflow li
      JOIN ft ON ft.email_key = li.email_key
      LEFT JOIN reg ON reg.email_key = li.email_key
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND (li.is_new_sale OR li.counts_as_sale)
       AND (ft.unified_confidence IN ('confirmed','recovered from ad fields')
            OR ft.resolution_layer IN ('utm','utm_campaign','ad_fields','ghl_source'))
  )
  SELECT row_hash, business_date, email_key, track, team, evidence, amount_received
    FROM pairs
   WHERE public.source_pair_class(track, team, hard_ad) = 'conflict'
   ORDER BY business_date DESC;
$function$;