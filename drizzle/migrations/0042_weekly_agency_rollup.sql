-- The weekly note's agency table: for each team, the registrations they brought
-- in the window, how many of those people actually turned up to a webinar,
-- the first-course sales, and what those buyers went on to spend in their
-- first 90 days. Later spend comes from the course platform's payments, which
-- is the only place it is recorded.
CREATE OR REPLACE FUNCTION public.weekly_agency_rollup(p_start date, p_end date)
RETURNS TABLE (
  agency_code text,
  registrations integer,
  attended integer,
  show_up_pct numeric,
  sales integer,
  buyers integer,
  later_spend_90d numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH lead_rows AS (
    SELECT l.lead_id,
           l.email_key,
           public.agency_channel_code(u.unified_channel) AS code
      FROM public.leads l
      JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
     WHERE coalesce(l.business_date, (l.captured_at AT TIME ZONE 'Asia/Kolkata')::date)
             BETWEEN p_start AND p_end
  ), attend AS (
    SELECT DISTINCT lower(p.email) AS email
      FROM public.zoom_participants p
     WHERE p.is_valid AND p.email IS NOT NULL
       AND (p.join_time AT TIME ZONE 'Asia/Kolkata')::date BETWEEN p_start AND p_end + 1
  ), regs AS (
    SELECT lr.code,
           count(*)::int AS registrations,
           count(*) FILTER (WHERE a.email IS NOT NULL)::int AS attended
      FROM lead_rows lr
      LEFT JOIN attend a ON a.email = lr.email_key
     GROUP BY 1
  ), sales_rows AS (
    SELECT public.agency_channel_code(sa.channel) AS code,
           sa.email_key,
           sa.business_date
      FROM public.sale_attribution sa
     WHERE sa.is_new_sale AND sa.business_date BETWEEN p_start AND p_end
  ), s AS (
    SELECT code, count(*)::int AS sales, count(DISTINCT email_key)::int AS buyers
      FROM sales_rows GROUP BY 1
  ), later AS (
    SELECT sr.code, coalesce(sum(t.amount_gross), 0)::numeric AS later_spend
      FROM sales_rows sr
      JOIN public.tm_payments t
        ON lower(t.buyer_email) = sr.email_key
       AND t.business_date BETWEEN sr.business_date AND sr.business_date + 90
     GROUP BY 1
  )
  SELECT coalesce(regs.code, s.code),
         coalesce(regs.registrations, 0),
         coalesce(regs.attended, 0),
         CASE WHEN coalesce(regs.registrations, 0) > 0
              THEN round(100.0 * regs.attended / regs.registrations, 1) END,
         coalesce(s.sales, 0),
         coalesce(s.buyers, 0),
         coalesce(later.later_spend, 0)
    FROM regs
    FULL JOIN s ON s.code = regs.code
    LEFT JOIN later ON later.code = coalesce(regs.code, s.code);
$$;

GRANT EXECUTE ON FUNCTION public.weekly_agency_rollup(date, date) TO service_role, authenticated;