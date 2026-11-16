CREATE TABLE IF NOT EXISTS public.person_links (
  payment_email text PRIMARY KEY,
  linked_email text,
  linked_phone text,
  confirmed_by text NOT NULL DEFAULT 'team',
  confirmed_on date NOT NULL DEFAULT current_date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.person_links TO authenticated;
GRANT ALL ON public.person_links TO service_role;

ALTER TABLE public.person_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "person_links readable by authenticated"
  ON public.person_links FOR SELECT TO authenticated USING (true);

-- Resolve the person behind a payment email: direct lead, then a team-confirmed
-- link, then the payer phone when it maps to exactly one person.
CREATE OR REPLACE FUNCTION public.sale_person_match(p_email text)
RETURNS TABLE(lead_email_key text, how text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT * FROM (
    SELECT p_email AS lead_email_key, 'direct'::text AS how
     WHERE EXISTS (SELECT 1 FROM public.leads l WHERE l.email_key = p_email)
    UNION ALL
    SELECT x.ek, 'team link'::text
      FROM (
        SELECT coalesce(
                 (SELECT l.email_key FROM public.leads l
                   WHERE l.email_key = lower(pl.linked_email) LIMIT 1),
                 (SELECT min(l.email_key) FROM public.leads l
                   WHERE l.phone_key = public.norm_phone(pl.linked_phone)
                   HAVING count(DISTINCT l.email_key) = 1)
               ) AS ek
          FROM public.person_links pl
         WHERE pl.payment_email = p_email
      ) x
     WHERE x.ek IS NOT NULL
    UNION ALL
    SELECT y.ek, 'matched by phone'::text
      FROM (
        SELECT (SELECT min(l.email_key) FROM public.leads l
                 WHERE l.phone_key = ph.p
                 HAVING count(DISTINCT l.email_key) = 1) AS ek
          FROM (
            SELECT coalesce(
                     (SELECT public.norm_phone(t.buyer_phone) FROM public.tm_payments t
                       WHERE lower(t.buyer_email) = p_email AND t.buyer_phone IS NOT NULL
                       LIMIT 1),
                     (SELECT public.norm_phone(e.buyer_phone) FROM public.tm_enrolments e
                       WHERE lower(e.buyer_email) = p_email AND e.buyer_phone IS NOT NULL
                       LIMIT 1)
                   ) AS p
          ) ph
         WHERE ph.p IS NOT NULL
      ) y
     WHERE y.ek IS NOT NULL
  ) m
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.rebuild_sale_attribution()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '240s'
AS $function$
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

  -- One person per paying email: the lead with the same email, else a
  -- team-confirmed link, else the payer's phone when it is unambiguous.
  CREATE TEMP TABLE _map ON COMMIT DROP AS
  SELECT k.email_key, m.lead_email_key, m.how
    FROM _keys k
    CROSS JOIN LATERAL public.sale_person_match(k.email_key) m;

  CREATE INDEX ON _map (email_key);
  ANALYZE _map;

  CREATE TEMP TABLE _ft ON COMMIT DROP AS
  SELECT DISTINCT ON (mp.email_key) mp.email_key, mp.how,
         u.unified_source, u.unified_channel,
         u.unified_tool, u.unified_confidence, u.resolution_layer
    FROM _map mp
    JOIN public.leads l ON l.email_key = mp.lead_email_key
    JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
   ORDER BY mp.email_key, l.captured_at NULLS LAST, l.lead_id;

  CREATE INDEX ON _ft (email_key);
  ANALYZE _ft;

  CREATE TEMP TABLE _reg ON COMMIT DROP AS
  SELECT p.email_key, p.label FROM public.team_register_person() p;
  CREATE INDEX ON _reg (email_key);
  ANALYZE _reg;

  DELETE FROM public.sale_attribution WHERE true;

  INSERT INTO public.sale_attribution
    (row_hash, business_date, month, email_key, channel, source, tool,
     confidence, layer, cash, is_new_sale, counts_as_sale)
  SELECT r.row_hash, r.business_date, to_char(r.business_date,'YYYY-MM'), r.email_key,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN r.team ELSE r.ch END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN r.team ELSE r.src END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN NULL ELSE r.tl END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN 'team-confirmed' ELSE r.conf END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN r.team_layer
              WHEN r.how IN ('team link','matched by phone') THEN r.how
              ELSE r.layer END,
         coalesce(r.amount_received,0), r.is_new_sale, r.counts_as_sale
    FROM (
      SELECT li.row_hash, li.business_date, li.email_key,
             coalesce(ft.unified_channel,'No lead record') AS ch,
             coalesce(ft.unified_source,'No lead record') AS src,
             ft.unified_tool AS tl,
             coalesce(ft.unified_confidence,'unknown') AS conf,
             ft.resolution_layer AS layer,
             ft.how AS how,
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
$function$;

-- The no-lead list is an L1 question only, and a buyer whose person we can now
-- name through a link or an unambiguous phone is no longer missing.
CREATE OR REPLACE FUNCTION public.nolead_buyer_rows(p_since date, p_until date)
 RETURNS TABLE(email_key text, email_raw text, payer_name text, first_date date, last_date date, sales integer, collected numeric, rows_count integer, bucket text, phone text, decision text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with buyers as (
    select li.email_key,
           min(li.email_raw) as email_raw,
           min(li.payer_name) as payer_name,
           min(li.business_date) as first_date,
           max(li.business_date) as last_date,
           count(*) filter (where li.is_new_sale)::int as sales,
           sum(li.amount_received) as collected,
           count(*)::int as rows_count
      from ledger_inflow li
     where li.counts_as_sale
       and li.product_tier = 'L1_SILVER'
       and li.email_key is not null
       and li.business_date between p_since and p_until
     group by li.email_key
  ), nolead as (
    select b.* from buyers b
     where not exists (select 1 from public.sale_person_match(b.email_key))
  ), ph as (
    select n.*,
      coalesce(
        (select norm_phone(t.buyer_phone) from tm_payments t
          where lower(t.buyer_email) = n.email_key and t.buyer_phone is not null limit 1),
        (select norm_phone(e.buyer_phone) from tm_enrolments e
          where lower(e.buyer_email) = n.email_key and e.buyer_phone is not null limit 1)
      ) as phone
    from nolead n
  ), c as (
    select ph.*, case when ph.phone is null then 0
                 else (select count(distinct l.email_key) from leads l where l.phone_key = ph.phone) end as cand
      from ph
  )
  select c.email_key, c.email_raw, c.payer_name, c.first_date, c.last_date,
         c.sales, c.collected, c.rows_count,
         case
           when c.phone is not null and c.cand > 1 then 'phone_conflict'
           when c.first_date < coalesce((select min(business_date) from leads), '1900-01-01'::date) then 'predates_lead_history'
           else 'not_in_lead_system'
         end as bucket,
         c.phone,
         bc.decision
    from c
    left join buyer_classification bc on bc.email_key = c.email_key
   order by c.collected desc;
$function$;