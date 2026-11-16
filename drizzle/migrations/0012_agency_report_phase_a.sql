-- AGENCY REPORT, PHASE A (data layer only).
-- Reads only the existing sources of truth: sale_attribution, leads +
-- lead_unified_source, daily_metrics x ad_accounts, zoom_attendance x
-- zoom_sessions, ledger_inflow. No private attribution logic lives here.

CREATE INDEX IF NOT EXISTS zoom_participants_email_valid_idx
  ON public.zoom_participants (lower(email)) WHERE is_valid;

CREATE TABLE IF NOT EXISTS public.agency_month (
  month text NOT NULL,
  channel text NOT NULL,
  agency_code text,
  spend numeric NOT NULL DEFAULT 0,
  retarget_spend numeric NOT NULL DEFAULT 0,
  spend_known boolean NOT NULL DEFAULT false,
  spend_note text,
  registrations bigint NOT NULL DEFAULT 0,
  show_ups bigint NOT NULL DEFAULT 0,
  sales bigint NOT NULL DEFAULT 0,
  fully_paid bigint NOT NULL DEFAULT 0,
  cash numeric NOT NULL DEFAULT 0,
  webinar_sales bigint NOT NULL DEFAULT 0,
  followup_sales bigint NOT NULL DEFAULT 0,
  other_timing_sales bigint NOT NULL DEFAULT 0,
  no_attendance_sales bigint NOT NULL DEFAULT 0,
  buyers bigint NOT NULL DEFAULT 0,
  later_cash_90 numeric NOT NULL DEFAULT 0,
  later_cash_per_buyer numeric,
  diamond_buyers bigint NOT NULL DEFAULT 0,
  window_open boolean NOT NULL DEFAULT false,
  ratios_ok boolean NOT NULL DEFAULT false,
  ratios_reason text,
  cost_per_registration numeric,
  cost_per_show_up numeric,
  cost_per_sale numeric,
  front_end_return numeric,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, channel)
);

GRANT SELECT ON public.agency_month TO authenticated;
GRANT ALL ON public.agency_month TO service_role;
ALTER TABLE public.agency_month ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agency_month readable by signed-in users"
  ON public.agency_month FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.agency_cohort (
  month text NOT NULL,
  channel text NOT NULL,
  registrations bigint NOT NULL DEFAULT 0,
  show_ups bigint NOT NULL DEFAULT 0,
  show_up_pct numeric,
  buyers bigint NOT NULL DEFAULT 0,
  webinar_sales bigint NOT NULL DEFAULT 0,
  followup_sales bigint NOT NULL DEFAULT 0,
  other_timing_sales bigint NOT NULL DEFAULT 0,
  no_attendance_sales bigint NOT NULL DEFAULT 0,
  later_cash_90 numeric NOT NULL DEFAULT 0,
  later_cash_per_buyer numeric,
  diamond_buyers bigint NOT NULL DEFAULT 0,
  window_open boolean NOT NULL DEFAULT false,
  too_few boolean NOT NULL DEFAULT false,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, channel)
);

GRANT SELECT ON public.agency_cohort TO authenticated;
GRANT ALL ON public.agency_cohort TO service_role;
ALTER TABLE public.agency_cohort ENABLE ROW LEVEL SECURITY;
CREATE POLICY "agency_cohort readable by signed-in users"
  ON public.agency_cohort FOR SELECT TO authenticated USING (true);

-- Which team's ad accounts pay for a channel. NULL means no spend is
-- attributable — never zero.
CREATE OR REPLACE FUNCTION public.agency_channel_code(p_channel text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE p_channel
    WHEN 'Sabhi Digital – Meta ads' THEN 'SD'
    WHEN 'Rajdeep (in-house) – Meta ads' THEN 'RJ'
    WHEN 'ScaleX (agency, closed)' THEN 'SX'
    ELSE NULL END
$$;

CREATE OR REPLACE FUNCTION public.rebuild_agency_report()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '240s'
AS $function$
DECLARE n bigint;
BEGIN
  -- One row per person, at their FIRST record, with that record's channel.
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

  -- Every day a person was actually in a webinar room (live or replay).
  CREATE TEMP TABLE _att ON COMMIT DROP AS
  SELECT DISTINCT za.email, zs.business_date AS bd
    FROM public.zoom_attendance za
    JOIN public.zoom_sessions zs ON zs.session_uuid = za.session_uuid
   WHERE zs.session_role IN ('live','replay')
     AND za.email IS NOT NULL AND zs.business_date IS NOT NULL;
  CREATE INDEX ON _att (email);
  ANALYZE _att;

  -- Registrations and show-ups per month x channel.
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

  -- Every L1 sale, with when it happened relative to a webinar the buyer attended.
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

  -- One row per L1 buyer, at their first L1, with what they bought afterwards
  -- inside 90 days (anything other than the L1 itself).
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
    SELECT to_char(d.date,'YYYY-MM') AS month, a.agency_code,
           sum(d.spend) AS spend,
           sum(d.spend) FILTER (WHERE a.account_role = 'retargeting_brand') AS retarget
      FROM public.daily_metrics d
      JOIN public.ad_accounts a ON a.account_id = d.account_id
     WHERE d.level = 'account' AND a.agency_code IS NOT NULL
     GROUP BY 1,2
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

REVOKE ALL ON FUNCTION public.rebuild_agency_report() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebuild_agency_report() TO service_role;

-- Golden figures for the agency report, so a later change that breaks them is caught.
CREATE OR REPLACE FUNCTION public.agency_golden_value(p_metric_id text, p_start date, p_end date)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE ms text := to_char(p_start,'YYYY-MM'); me text := to_char(p_end,'YYYY-MM'); v numeric;
BEGIN
  IF p_metric_id = 'agency_sales_sd_meta' THEN
    SELECT coalesce(sum(sales),0) INTO v FROM agency_month
     WHERE channel = 'Sabhi Digital – Meta ads' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_fully_paid_sd_meta' THEN
    SELECT coalesce(sum(fully_paid),0) INTO v FROM agency_month
     WHERE channel = 'Sabhi Digital – Meta ads' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_sales_sd_google' THEN
    SELECT coalesce(sum(sales),0) INTO v FROM agency_month
     WHERE channel = 'Sabhi Digital – Google Ads' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_sales_rj' THEN
    SELECT coalesce(sum(sales),0) INTO v FROM agency_month
     WHERE channel = 'Rajdeep (in-house) – Meta ads' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_spend_sd' THEN
    SELECT coalesce(sum(spend),0) INTO v FROM agency_month
     WHERE channel = 'Sabhi Digital – Meta ads' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_spend_rj' THEN
    SELECT coalesce(sum(spend),0) INTO v FROM agency_month
     WHERE channel = 'Rajdeep (in-house) – Meta ads' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_spend_sx' THEN
    SELECT coalesce(sum(spend),0) INTO v FROM agency_month
     WHERE channel = 'ScaleX (agency, closed)' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_showup_pct_sd_meta' THEN
    SELECT round(100.0 * sum(show_ups) / nullif(sum(registrations),0), 2) INTO v FROM agency_month
     WHERE channel = 'Sabhi Digital – Meta ads' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_showup_pct_rj' THEN
    SELECT round(100.0 * sum(show_ups) / nullif(sum(registrations),0), 2) INTO v FROM agency_month
     WHERE channel = 'Rajdeep (in-house) – Meta ads' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_showup_pct_sd_google' THEN
    SELECT round(100.0 * sum(show_ups) / nullif(sum(registrations),0), 2) INTO v FROM agency_month
     WHERE channel = 'Sabhi Digital – Google Ads' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_later_cash_per_buyer_sd_meta' THEN
    SELECT round(sum(later_cash_90) / nullif(sum(buyers),0), 2) INTO v FROM agency_month
     WHERE channel = 'Sabhi Digital – Meta ads' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_later_cash_per_buyer_sx' THEN
    SELECT round(sum(later_cash_90) / nullif(sum(buyers),0), 2) INTO v FROM agency_month
     WHERE channel = 'ScaleX (agency, closed)' AND month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_timing_webinar' THEN
    SELECT coalesce(sum(webinar_sales),0) INTO v FROM agency_month WHERE month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_timing_followup' THEN
    SELECT coalesce(sum(followup_sales),0) INTO v FROM agency_month WHERE month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_timing_other' THEN
    SELECT coalesce(sum(other_timing_sales),0) INTO v FROM agency_month WHERE month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_timing_none' THEN
    SELECT coalesce(sum(no_attendance_sales),0) INTO v FROM agency_month WHERE month BETWEEN ms AND me;
  ELSIF p_metric_id = 'agency_total_sales' THEN
    SELECT coalesce(sum(sales),0) INTO v FROM agency_month WHERE month BETWEEN ms AND me;
  ELSE
    RAISE EXCEPTION 'No computation is defined for %', p_metric_id;
  END IF;
  RETURN v;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.agency_golden_value(text, date, date) TO service_role, authenticated;

-- A3: the team-basis symmetry check ran for every team, but the proof store
-- keeps one row per check per day, so only the first team (SD) was ever
-- recorded and RJ could never pass a gate it was never asked. Each team now
-- carries its own check id.
CREATE OR REPLACE FUNCTION public.inv_basis_symmetry_rows(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  out_rows jsonb := '[]'::jsonb;
  r record;
  v_id text;
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
    v_id := CASE WHEN r.team IN ('SD','RJ','SX')
                 THEN 'inv_basis_symmetry_' || lower(r.team)
                 ELSE 'inv_basis_symmetry' END;
    out_rows := out_rows || jsonb_build_array(jsonb_build_object(
      'check_id', v_id, 'checked_at',v_now,'for_date',p_end,
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
$function$;