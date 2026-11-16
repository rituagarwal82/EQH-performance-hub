CREATE OR REPLACE FUNCTION public.daily_email_month_figures(p_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start date := date_trunc('month', p_date)::date;
  v_pstart date := (date_trunc('month', p_date) - interval '1 month')::date;
  v_pend date := v_pstart + (p_date - v_start);
  v jsonb;
BEGIN
  WITH windows AS (
    SELECT 'now'::text AS slot, v_start AS s, p_date AS e
    UNION ALL SELECT 'prev', v_pstart, least(v_pend, (date_trunc('month', p_date) - interval '1 day')::date)
  ), sales AS (
    SELECT w.slot, sa.channel,
           count(*) FILTER (WHERE sa.is_new_sale)::int AS sales,
           count(*) FILTER (WHERE sa.counts_as_sale)::int AS fully_paid,
           coalesce(sum(sa.cash) FILTER (WHERE sa.is_new_sale), 0)::numeric AS cash
      FROM windows w
      JOIN public.sale_attribution sa ON sa.business_date BETWEEN w.s AND w.e
     GROUP BY 1, 2
  ), regs AS (
    SELECT w.slot, u.unified_channel AS channel, count(*)::int AS registrations
      FROM windows w
      JOIN public.leads l
        ON coalesce(l.business_date, (l.captured_at AT TIME ZONE 'Asia/Kolkata')::date)
             BETWEEN w.s AND w.e
      JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
     GROUP BY 1, 2
  ), prm AS (
    SELECT d.date, d.account_id, sum(d.spend) AS spend
      FROM public.daily_metrics d
      JOIN public.ad_entities e ON e.entity_id = d.entity_id
     WHERE d.level = 'campaign' AND e.name ILIKE 'PRM\_%'
       AND d.date BETWEEN v_pstart AND p_date
     GROUP BY 1, 2
  ), acct AS (
    SELECT d.date, d.account_id, d.spend, coalesce(p.spend, 0) AS prm_spend
      FROM public.daily_metrics d
      LEFT JOIN prm p ON p.date = d.date AND p.account_id = d.account_id
     WHERE d.level = 'account' AND d.date BETWEEN v_pstart AND p_date
  ), split AS (
    SELECT date, least(prm_spend, spend) AS spend, 'PRM'::text AS code
      FROM acct WHERE prm_spend > 0
    UNION ALL
    SELECT date, greatest(spend - prm_spend, 0),
           public.account_agency_at(account_id, date)
      FROM acct
  ), spend AS (
    SELECT w.slot, s.code AS agency_code, sum(s.spend)::numeric AS spend
      FROM windows w
      JOIN split s ON s.date BETWEEN w.s AND w.e
     WHERE s.code IS NOT NULL AND s.spend <> 0
     GROUP BY 1, 2
  )
  SELECT jsonb_build_object(
    'start', v_start,
    'prev_start', v_pstart,
    'prev_end', (SELECT e FROM windows WHERE slot = 'prev'),
    'sales', coalesce((SELECT jsonb_agg(to_jsonb(sales)) FROM sales), '[]'::jsonb),
    'registrations', coalesce((SELECT jsonb_agg(to_jsonb(regs)) FROM regs), '[]'::jsonb),
    'spend', coalesce((SELECT jsonb_agg(to_jsonb(spend)) FROM spend), '[]'::jsonb)
  ) INTO v;

  RETURN coalesce(v, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.daily_email_month_figures(date) TO service_role, authenticated;