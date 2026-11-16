-- For each source this month: how many registrations we hold, and how many of
-- them carry the ad that produced them. A source spending money whose
-- registrations carry no ad cannot be judged yet, and the email says so.
CREATE OR REPLACE FUNCTION public.channel_traced_registrations(p_date date)
RETURNS TABLE (channel text, registrations integer, traced integer, first_seen date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.unified_channel,
         count(*)::int,
         count(*) FILTER (WHERE l.ad_entity_ref IS NOT NULL)::int,
         min(coalesce(l.business_date, (l.captured_at AT TIME ZONE 'Asia/Kolkata')::date))
    FROM public.leads l
    JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
   WHERE coalesce(l.business_date, (l.captured_at AT TIME ZONE 'Asia/Kolkata')::date)
           BETWEEN date_trunc('month', p_date)::date AND p_date
   GROUP BY 1;
$$;

GRANT EXECUTE ON FUNCTION public.channel_traced_registrations(date) TO service_role, authenticated;