-- The first-touch scan only needs the buyers that appear in the ledger
-- (about 8k emails), not all 243k leads. Restricting it takes the refresh
-- from ~110 seconds to a few seconds, so it fits inside a scheduled call.
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

  DELETE FROM public.sale_attribution;

  INSERT INTO public.sale_attribution
    (row_hash, business_date, month, email_key, channel, source, tool,
     confidence, layer, cash, is_new_sale, counts_as_sale)
  SELECT r.row_hash, r.business_date, to_char(r.business_date,'YYYY-MM'), r.email_key,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN r.team ELSE r.ch END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN r.team ELSE r.src END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN NULL ELSE r.tl END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN 'team-confirmed' ELSE r.conf END,
         CASE WHEN r.cls IN ('gap','agreement_team','enrichment') THEN 'ledger_team_source' ELSE r.layer END,
         coalesce(r.amount_received,0), r.is_new_sale, r.counts_as_sale
    FROM (
      SELECT li.row_hash, li.business_date, li.email_key,
             coalesce(ft.unified_channel,'No lead record') AS ch,
             coalesce(ft.unified_source,'No lead record') AS src,
             ft.unified_tool AS tl,
             coalesce(ft.unified_confidence,'unknown') AS conf,
             ft.resolution_layer AS layer,
             public.team_source_label(li.source_of_student_raw) AS team,
             public.source_pair_class(
               coalesce(ft.unified_channel,'No lead record'),
               public.team_source_label(li.source_of_student_raw),
               (ft.unified_channel LIKE '%Meta ads%' AND ft.unified_channel NOT LIKE '%unknown%'
                AND ft.unified_confidence IN ('confirmed','recovered from ad fields'))
             ) AS cls,
             li.is_new_sale, li.counts_as_sale, li.amount_received
        FROM public.ledger_inflow li
        LEFT JOIN _ft ft ON ft.email_key = li.email_key
       WHERE li.product_tier = 'L1_SILVER'
         AND li.business_date IS NOT NULL
         AND (li.is_new_sale OR li.counts_as_sale)
    ) r;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;