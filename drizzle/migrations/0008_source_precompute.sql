CREATE TABLE IF NOT EXISTS public.sale_attribution (
  row_hash text PRIMARY KEY,
  business_date date,
  month text NOT NULL,
  email_key text,
  channel text NOT NULL,
  source text NOT NULL,
  tool text,
  confidence text NOT NULL,
  layer text,
  cash numeric NOT NULL DEFAULT 0,
  is_new_sale boolean NOT NULL DEFAULT false,
  counts_as_sale boolean NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sale_attribution_bd_idx ON public.sale_attribution (business_date);
CREATE INDEX IF NOT EXISTS sale_attribution_month_idx ON public.sale_attribution (month);

CREATE TABLE IF NOT EXISTS public.lead_source_month (
  month text NOT NULL,
  channel text NOT NULL,
  source text NOT NULL,
  tool_key text NOT NULL,
  tool text,
  confidence text NOT NULL,
  leads bigint NOT NULL DEFAULT 0,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, channel, source, tool_key)
);

CREATE INDEX IF NOT EXISTS lead_source_month_month_idx ON public.lead_source_month (month);

GRANT SELECT ON public.sale_attribution TO authenticated;
GRANT ALL ON public.sale_attribution TO service_role;
GRANT SELECT ON public.lead_source_month TO authenticated;
GRANT ALL ON public.lead_source_month TO service_role;

ALTER TABLE public.sale_attribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_source_month ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sale_attribution read" ON public.sale_attribution;
CREATE POLICY "sale_attribution read" ON public.sale_attribution
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "lead_source_month read" ON public.lead_source_month;
CREATE POLICY "lead_source_month read" ON public.lead_source_month
  FOR SELECT TO authenticated USING (true);

CREATE OR REPLACE FUNCTION public.rebuild_sale_attribution()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE n bigint;
BEGIN
  CREATE TEMP TABLE _ft ON COMMIT DROP AS
  SELECT DISTINCT ON (l.email_key) l.email_key, u.unified_source, u.unified_channel,
         u.unified_tool, u.unified_confidence, u.resolution_layer
    FROM public.leads l
    JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
   WHERE l.email_key IS NOT NULL
   ORDER BY l.email_key, l.captured_at NULLS LAST, l.lead_id;

  CREATE INDEX ON _ft (email_key);

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

CREATE OR REPLACE FUNCTION public.rebuild_lead_source_month()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE n bigint;
BEGIN
  DELETE FROM public.lead_source_month;

  INSERT INTO public.lead_source_month (month, channel, source, tool_key, tool, confidence, leads)
  SELECT to_char(l.business_date,'YYYY-MM'),
         u.unified_channel, u.unified_source,
         coalesce(u.unified_tool,''), u.unified_tool,
         CASE WHEN bool_or(u.unified_confidence = 'inferred') THEN 'inferred'
              ELSE min(u.unified_confidence) END,
         count(*)
    FROM public.leads l
    JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
   WHERE l.business_date IS NOT NULL
   GROUP BY 1,2,3,4,5;

  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.rebuild_source_precompute()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE s bigint; l bigint;
BEGIN
  s := public.rebuild_sale_attribution();
  l := public.rebuild_lead_source_month();
  RETURN jsonb_build_object('sales', s, 'lead_rows', l, 'rebuilt_at', now());
END;
$$;

CREATE OR REPLACE FUNCTION public.source_month_matrix(p_start date, p_end date)
RETURNS TABLE(month text, channel text, source text, tool text, confidence text,
              leads bigint, sales_team bigint, sales_paid bigint, cash numeric)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH sales AS (
    SELECT a.month AS m, a.channel AS ch, a.source AS src, a.tool AS tl,
           CASE WHEN bool_or(a.confidence = 'team-confirmed') THEN 'team-confirmed'
                ELSE min(a.confidence) END AS conf,
           count(*) FILTER (WHERE a.is_new_sale) AS s_team,
           count(*) FILTER (WHERE a.counts_as_sale) AS s_paid,
           sum(a.cash) AS cash
      FROM public.sale_attribution a
     WHERE a.business_date BETWEEN p_start AND p_end
     GROUP BY 1,2,3,4
  ),
  lead_counts AS (
    SELECT c.month AS m, c.channel AS ch, c.source AS src, c.tool AS tl,
           CASE WHEN bool_or(c.confidence = 'inferred') THEN 'inferred'
                ELSE min(c.confidence) END AS conf,
           sum(c.leads) AS leads
      FROM public.lead_source_month c
     WHERE c.month BETWEEN to_char(p_start,'YYYY-MM') AND to_char(p_end,'YYYY-MM')
     GROUP BY 1,2,3,4
  )
  SELECT coalesce(s.m, c.m), coalesce(s.ch, c.ch), coalesce(s.src, c.src),
         coalesce(s.tl, c.tl), coalesce(s.conf, c.conf),
         coalesce(c.leads,0), coalesce(s.s_team,0), coalesce(s.s_paid,0), coalesce(s.cash,0)
    FROM sales s
    FULL OUTER JOIN lead_counts c
      ON c.m = s.m AND c.ch = s.ch AND c.src = s.src AND c.tl IS NOT DISTINCT FROM s.tl
   ORDER BY 1 DESC, 9 DESC, 6 DESC;
$$;

GRANT EXECUTE ON FUNCTION public.source_month_matrix(date, date) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.rebuild_source_precompute() TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_sale_attribution() TO service_role;
GRANT EXECUTE ON FUNCTION public.rebuild_lead_source_month() TO service_role;