CREATE OR REPLACE FUNCTION public.rebuild_agency_report()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '240s'
AS $function$
DECLARE n bigint;
BEGIN
  CREATE TEMP TABLE _p ON COMMIT DROP AS
  SELECT DISTINCT ON (coalesce(l.email_key, l.lead_id))
         coalesce(l.email_key, l.lead_id) AS pk,
         l.email_key,
         coalesce(l.business_date, (l.captured_at AT TIME ZONE 'Asia/Kolkata')::date) AS reg_date,
         u.unified_channel AS channel
    FROM public.leads l
    JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
   ORDER BY 1,
         coalesce(l.business_date, (l.captured_at AT TIME ZONE 'Asia/Kolkata')::date),
         l.captured_at NULLS LAST, l.lead_id;
  CREATE INDEX ON _p (email_key);
  ANALYZE _p;

  CREATE TEMP TABLE _att ON COMMIT DROP AS
  SELECT DISTINCT za.email, zs.business_date AS bd
    FROM public.zoom_attendance za
    JOIN public.zoom_sessions zs ON zs.session_uuid = za.session_uuid
   WHERE zs.session_role IN ('live','replay')
     AND za.email IS NOT NULL AND zs.business_date IS NOT NULL;
  CREATE INDEX ON _att (email);
  ANALYZE _att;

  CREATE TEMP TABLE _reg ON COMMIT DROP AS
  SELECT to_char(p.reg_date,'YYYY-MM') AS month, p.channel,
         count(*)::bigint AS registrations,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM _att a
            WHERE a.email = p.email_key
              AND a.bd BETWEEN p.reg_date - 1 AND p.reg_date + 14))::bigint AS show_ups
    FROM _p p
   WHERE p.reg_date IS NOT NULL
   GROUP BY 1,2;

  CREATE TEMP TABLE _sale ON COMMIT DROP AS
  SELECT s.row_hash, s.month, s.channel, s.email_key, s.business_date AS d,
         s.is_new_sale, s.counts_as_sale, s.cash,
         CASE
           WHEN NOT EXISTS (SELECT 1 FROM _att a WHERE a.email = s.email_key) THEN 'none'
           WHEN EXISTS (SELECT 1 FROM _att a WHERE a.email = s.email_key AND a.bd = s.business_date) THEN 'webinar'
           WHEN EXISTS (SELECT 1 FROM _att a WHERE a.email = s.email_key
                          AND s.business_date BETWEEN a.bd + 1 AND a.bd + 30) THEN 'followup'
           ELSE 'other' END AS timing
    FROM public.sale_attribution s;
  CREATE INDEX ON _sale (email_key);
  ANALYZE _sale;

  CREATE TEMP TABLE _buyer ON COMMIT DROP AS
  SELECT b.email_key, b.channel, b.d AS l1_date, to_char(b.d,'YYYY-MM') AS sale_month,
         coalesce((SELECT sum(li.amount_received) FROM public.ledger_inflow li
                    WHERE li.email_key = b.email_key
                      AND li.product_tier IS DISTINCT FROM 'L1_SILVER'
                      AND li.business_date BETWEEN b.d AND b.d + 90), 0) AS later_cash,
         EXISTS (SELECT 1 FROM public.ledger_inflow li
                  WHERE li.email_key = b.email_key AND li.product_tier = 'L3_DIAMOND'
                    AND li.business_date BETWEEN b.d AND b.d + 90) AS diamond
    FROM (SELECT s.email_key, s.channel, min(s.d) AS d
            FROM _sale s WHERE s.is_new_sale AND s.email_key IS NOT NULL
           GROUP BY 1,2) b;
  CREATE INDEX ON _buyer (email_key);
  ANALYZE _buyer;

  DELETE FROM public.agency_month WHERE true;

  INSERT INTO public.agency_month (
    month, channel, agency_code, spend, retarget_spend, spend_known, spend_note,
    registrations, show_ups, sales, fully_paid, cash,
    webinar_sales, followup_sales, other_timing_sales, no_attendance_sales,
    buyers, later_cash_90, later_cash_per_buyer, diamond_buyers, window_open,
    ratios_ok, ratios_reason,
    cost_per_registration, cost_per_show_up, cost_per_sale, front_end_return, computed_at)
  WITH base AS (
    SELECT month, channel FROM _reg
    UNION
    SELECT month, channel FROM public.sale_attribution
  ), spend AS (
    -- Date-effective ownership: whoever owned the account on the spend day.
    SELECT month, agency_code, spend, retarget FROM public.spend_agency_month()
  ), sales AS (
    SELECT month, channel,
           count(*) FILTER (WHERE is_new_sale)::bigint AS sales,
           count(*) FILTER (WHERE counts_as_sale)::bigint AS fully_paid,
           sum(cash) FILTER (WHERE is_new_sale) AS cash,
           count(*) FILTER (WHERE is_new_sale AND timing = 'webinar')::bigint AS w,
           count(*) FILTER (WHERE is_new_sale AND timing = 'followup')::bigint AS f,
           count(*) FILTER (WHERE is_new_sale AND timing = 'other')::bigint AS o,
           count(*) FILTER (WHERE is_new_sale AND timing = 'none')::bigint AS nn
      FROM _sale GROUP BY 1,2
  ), backend AS (
    SELECT sale_month AS month, channel, count(*)::bigint AS buyers,
           sum(later_cash) AS later_cash,
           count(*) FILTER (WHERE diamond)::bigint AS diamond
      FROM _buyer GROUP BY 1,2
  )
  SELECT b.month, b.channel, code,
         coalesce(sp.spend, 0),
         coalesce(sp.retarget, 0),
         sp.spend IS NOT NULL,
         CASE WHEN sp.spend IS NOT NULL THEN NULL
              WHEN b.channel = 'Sabhi Digital – Google Ads' THEN 'spend not connected'
              WHEN code IS NOT NULL THEN 'no spend recorded for this team in this month'
              ELSE 'no ad spend belongs to this source' END,
         coalesce(r.registrations, 0), coalesce(r.show_ups, 0),
         coalesce(s.sales, 0), coalesce(s.fully_paid, 0), coalesce(s.cash, 0),
         coalesce(s.w, 0), coalesce(s.f, 0), coalesce(s.o, 0), coalesce(s.nn, 0),
         coalesce(bk.buyers, 0), coalesce(bk.later_cash, 0),
         CASE WHEN coalesce(bk.buyers,0) = 0 THEN NULL
              ELSE round(bk.later_cash / bk.buyers, 2) END,
         coalesce(bk.diamond, 0),
         (to_date(b.month || '-01','YYYY-MM-DD') + interval '1 month' + interval '90 days')::date > current_date,
         ratios_ok,
         CASE WHEN ratios_ok THEN NULL
              WHEN sp.spend IS NULL AND b.channel = 'Sabhi Digital – Google Ads'
                THEN 'Google spend is not connected, so no cost or return can be shown'
              WHEN code IS NULL THEN 'no ad spend belongs to this source, so cost per result does not apply'
              ELSE coalesce(st.ratio_note, 'ratios are held for this team') END,
         CASE WHEN ratios_ok AND coalesce(r.registrations,0) > 0
              THEN round((coalesce(sp.spend,0) - coalesce(sp.retarget,0)) / r.registrations, 2) END,
         CASE WHEN ratios_ok AND coalesce(r.show_ups,0) > 0
              THEN round((coalesce(sp.spend,0) - coalesce(sp.retarget,0)) / r.show_ups, 2) END,
         CASE WHEN ratios_ok AND coalesce(s.sales,0) > 0
              THEN round(coalesce(sp.spend,0) / s.sales, 2) END,
         CASE WHEN ratios_ok AND coalesce(sp.spend,0) > 0
              THEN round(coalesce(s.cash,0) / sp.spend, 4) END,
         now()
    FROM base b
    CROSS JOIN LATERAL (SELECT public.agency_channel_code(b.channel) AS code) c
    LEFT JOIN spend sp ON sp.month = b.month AND sp.agency_code = c.code
    LEFT JOIN public.agency_spend_status st ON st.agency_code = c.code
    LEFT JOIN _reg r ON r.month = b.month AND r.channel = b.channel
    LEFT JOIN sales s ON s.month = b.month AND s.channel = b.channel
    LEFT JOIN backend bk ON bk.month = b.month AND bk.channel = b.channel
    CROSS JOIN LATERAL (SELECT (
        sp.spend IS NOT NULL
        AND coalesce(st.ratios_computable, false)
        AND NOT coalesce(st.ratios_hold, false)
        AND st.ratios_valid_from IS NOT NULL
        AND to_date(b.month || '-01','YYYY-MM-DD') >= date_trunc('month', st.ratios_valid_from)::date
      ) AS ratios_ok) g;

  GET DIAGNOSTICS n = ROW_COUNT;

  DELETE FROM public.agency_cohort WHERE true;

  INSERT INTO public.agency_cohort (
    month, channel, registrations, show_ups, show_up_pct, buyers,
    webinar_sales, followup_sales, other_timing_sales, no_attendance_sales,
    later_cash_90, later_cash_per_buyer, diamond_buyers, window_open, too_few, computed_at)
  WITH cohort AS (
    SELECT to_char(p.reg_date,'YYYY-MM') AS month, p.channel, p.email_key,
           EXISTS (SELECT 1 FROM _att a WHERE a.email = p.email_key
                    AND a.bd BETWEEN p.reg_date - 1 AND p.reg_date + 14) AS showed
      FROM _p p WHERE p.reg_date IS NOT NULL
  ), joined AS (
    SELECT c.month, c.channel, c.showed, bu.later_cash, bu.diamond, bu.l1_date,
           (SELECT s.timing FROM _sale s
             WHERE s.email_key = c.email_key AND s.is_new_sale
             ORDER BY s.d LIMIT 1) AS timing
      FROM cohort c
      LEFT JOIN _buyer bu ON bu.email_key = c.email_key
  )
  SELECT month, channel, count(*)::bigint,
         count(*) FILTER (WHERE showed)::bigint,
         CASE WHEN count(*) = 0 THEN NULL
              ELSE round(100.0 * count(*) FILTER (WHERE showed) / count(*), 2) END,
         count(*) FILTER (WHERE l1_date IS NOT NULL)::bigint,
         count(*) FILTER (WHERE timing = 'webinar')::bigint,
         count(*) FILTER (WHERE timing = 'followup')::bigint,
         count(*) FILTER (WHERE timing = 'other')::bigint,
         count(*) FILTER (WHERE timing = 'none')::bigint,
         coalesce(sum(later_cash), 0),
         CASE WHEN count(*) FILTER (WHERE l1_date IS NOT NULL) = 0 THEN NULL
              ELSE round(coalesce(sum(later_cash),0) / count(*) FILTER (WHERE l1_date IS NOT NULL), 2) END,
         count(*) FILTER (WHERE diamond)::bigint,
         (to_date(month || '-01','YYYY-MM-DD') + interval '1 month' + interval '90 days')::date > current_date,
         count(*) FILTER (WHERE l1_date IS NOT NULL) < 30,
         now()
    FROM joined GROUP BY 1,2;

  RETURN n;
END;
$function$;