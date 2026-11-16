-- 0. corrected golden anchor
UPDATE public.golden_tests SET expected_value = 201, note = coalesce(note,'') || ' | corrected 2026-09-06: 152 was an incomplete-month count'
 WHERE metric_id = 'ledger_l1_new_sales' AND window_start = '2026-08-01' AND window_end = '2026-08-31';

-- 6. show-up: matched-set attendees
DROP FUNCTION IF EXISTS public.zoom_event_rows(date, date, boolean);
CREATE FUNCTION public.zoom_event_rows(p_start date, p_end date, p_include_test boolean DEFAULT false)
 RETURNS TABLE(event_key text, event_date date, sessions bigint, live_sessions bigint, replay_sessions bigint, registrants bigint, attendees bigint, attendees_matched bigint, sessions_without_registrants bigint, at_30 bigint, at_60 bigint, at_90 bigint, sessions_missing_attendance bigint, first_start timestamp with time zone)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with s as (
    select * from public.zoom_sessions z
    where z.event_key is not null
      and z.event_key >= to_char(p_start,'YYYY-MM-DD')
      and z.event_key <= to_char(p_end,'YYYY-MM-DD')
      and (p_include_test or z.session_role <> 'test')
  ), per as (
    select
      s.event_key, s.session_uuid, s.start_time, s.session_role,
      case when s.zoom_id is null then s.total_registrants
           when s.session_uuid = (select min(z2.session_uuid) from public.zoom_sessions z2
                                   where z2.zoom_id = s.zoom_id and z2.event_key = s.event_key)
           then s.total_registrants else 0 end as reg,
      s.participants_status,
      (select count(*) from public.zoom_attendance a where a.session_uuid = s.session_uuid) as att,
      (select count(*) from public.zoom_attendance a where a.session_uuid = s.session_uuid
         and a.first_join <= s.start_time + interval '30 minutes'
         and a.last_leave >= s.start_time + interval '30 minutes') as a30,
      (select count(*) from public.zoom_attendance a where a.session_uuid = s.session_uuid
         and a.first_join <= s.start_time + interval '60 minutes'
         and a.last_leave >= s.start_time + interval '60 minutes') as a60,
      (select count(*) from public.zoom_attendance a where a.session_uuid = s.session_uuid
         and a.first_join <= s.start_time + interval '90 minutes'
         and a.last_leave >= s.start_time + interval '90 minutes') as a90
    from s
  )
  select
    per.event_key,
    per.event_key::date,
    count(*)::bigint,
    count(*) filter (where per.session_role = 'live')::bigint,
    count(*) filter (where per.session_role = 'replay')::bigint,
    coalesce(sum(per.reg),0)::bigint,
    coalesce(sum(per.att),0)::bigint,
    -- only sessions that reported a registrant count may feed the show-up ratio
    coalesce(sum(per.att) filter (where coalesce(per.reg,0) > 0),0)::bigint,
    count(*) filter (where coalesce(per.reg,0) = 0)::bigint,
    coalesce(sum(per.a30),0)::bigint,
    coalesce(sum(per.a60),0)::bigint,
    coalesce(sum(per.a90),0)::bigint,
    count(*) filter (where per.participants_status in ('failed','unavailable'))::bigint,
    min(per.start_time)
  from per
  group by per.event_key
  order by per.event_key desc
$function$;
REVOKE ALL ON FUNCTION public.zoom_event_rows(date,date,boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.zoom_event_rows(date,date,boolean) TO authenticated, service_role;

-- 4. one paid definition product-wide
CREATE OR REPLACE FUNCTION public.ledger_paid_daily(p_start date, p_end date)
 RETURNS TABLE(business_date date, collected_all numeric, collected_new_sale numeric, collected_no_lead numeric, collected_instalment numeric, collected_paid_gross numeric, collected_paid_exgst numeric, rows_all bigint, rows_paid bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH l AS (
    SELECT li.business_date, li.amount_received, li.is_new_sale,
           EXISTS (SELECT 1 FROM public.leads x WHERE x.email_key = li.email_key) AS has_lead,
           -- single product-wide paid rule: the deduped lead_attribution view
           EXISTS (SELECT 1 FROM public.lead_attribution la
                    WHERE la.email_key = li.email_key AND la.is_paid) AS has_paid_marker
      FROM public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND li.email_key IS NOT NULL
    UNION ALL
    SELECT li.business_date, li.amount_received, li.is_new_sale, false, false
      FROM public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER'
       AND li.business_date BETWEEN p_start AND p_end
       AND li.email_key IS NULL
  )
  SELECT l.business_date,
         coalesce(sum(l.amount_received), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.is_new_sale), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.is_new_sale AND NOT l.has_lead), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE NOT l.is_new_sale), 0)::numeric,
         coalesce(sum(l.amount_received) FILTER (WHERE l.is_new_sale AND l.has_paid_marker), 0)::numeric,
         round(coalesce(sum(l.amount_received) FILTER (WHERE l.is_new_sale AND l.has_paid_marker), 0)::numeric / 1.18, 2),
         count(*)::bigint,
         count(*) FILTER (WHERE l.is_new_sale AND l.has_paid_marker)::bigint
    FROM l GROUP BY l.business_date ORDER BY l.business_date
$function$;

-- 3. placement rollup: account grain only
CREATE OR REPLACE FUNCTION public.placement_rollup(p_start date, p_end date)
 RETURNS TABLE(placement text, rows_n bigint, spend numeric, impressions bigint, link_clicks bigint, leads bigint, days_covered bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select
    coalesce(m.placement, '(not reported)') as placement,
    count(*)::bigint,
    coalesce(sum(m.spend),0),
    coalesce(sum(m.impressions),0)::bigint,
    coalesce(sum(m.link_clicks),0)::bigint,
    case when count(*) filter (where m.leads is not null) = 0 then null
         else sum(m.leads)::bigint end,
    count(distinct m.date)::bigint
  from daily_metrics m
  where m.date between p_start and p_end
    and m.level = 'account'
  group by 1 order by 3 desc
$function$;

-- 7. agency rollup: window-bounded sales
CREATE OR REPLACE FUNCTION public.lead_agency_rollup(p_since date, p_until date)
 RETURNS TABLE(agency_code text, leads bigint, registered_leads bigint, leads_with_email bigint, sales bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with l as (
    select coalesce(agency_code, 'UNASSIGNED') as code, email_key, is_registered
    from public.leads where business_date between p_since and p_until
  )
  select l.code, count(*)::bigint,
    count(*) filter (where l.is_registered)::bigint,
    count(*) filter (where l.email_key is not null)::bigint,
    count(distinct s.person_key)::bigint
  from l
  left join public.tm_sales s
    on s.person_key = l.email_key
   and s.business_date between p_since and p_until
  group by l.code order by count(*) desc
$function$;

-- 1. matured sale rate: L1 only
CREATE OR REPLACE FUNCTION public.account_matured_sale_rate(p_start date, p_end date)
 RETURNS TABLE(matured_leads bigint, matured_sales bigint, sale_rate numeric)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with l as (
    select l.email_key, l.business_date
    from public.leads l
    where l.business_date >= p_start and l.business_date <= p_end - 14
      and l.is_import = false and l.is_registered and l.email_key is not null
  ), s as (
    select l.email_key,
           exists (select 1 from public.ledger_inflow li
                    where li.email_key = l.email_key and li.is_new_sale
                      and li.product_tier = 'L1_SILVER'
                      and li.business_date >= l.business_date
                      and li.business_date <= p_end) as bought
    from l
  )
  select count(*)::bigint, count(*) filter (where bought)::bigint,
         case when count(*) > 0 then count(*) filter (where bought)::numeric / count(*) end
  from s
$function$;

-- 1. scaling inputs: dashboard-consistent bases, no participant scan
CREATE OR REPLACE FUNCTION public.scaling_inputs(p_date date)
 RETURNS TABLE(window_label text, days integer, spend numeric, registrations bigint, cpl numeric, attendees_60 bigint, cost_per_60 numeric, active_adsets bigint, sales bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  with w as (
    select '7d'::text lbl, 7 d, (p_date - 6)::date s, p_date e
    union all select '28d', 28, (p_date - 27)::date, p_date
  ), spend as (
    select w.lbl,
           coalesce(sum(m.spend),0)::numeric spend,
           coalesce(sum(m.leads),0)::bigint registrations
    from w left join (
      select m.date, m.spend, m.leads
      from public.daily_metrics m
      join public.ad_accounts a on a.account_id = m.account_id
      where m.level = 'account' and a.lead_tracking_status = 'working'
    ) m on m.date >= w.s and m.date <= w.e
    group by 1
  ), zoom as (
    select w.lbl, coalesce(sum(z.at_60),0)::bigint a60
    from w left join lateral (
      select sum(e.at_60) at_60 from public.zoom_event_rows(w.s, w.e, false) e
    ) z on true
    group by 1
  ), adsets as (
    select w.lbl, count(distinct m.entity_id)::bigint n
    from w left join (
      select m.date, m.entity_id
      from public.daily_metrics m
      join public.ad_accounts a on a.account_id = m.account_id
      where m.level = 'adset' and m.spend > 0 and a.lead_tracking_status = 'working'
    ) m on m.date >= w.s and m.date <= w.e
    group by 1
  ), sales as (
    select w.lbl, count(li.*)::bigint n
    from w left join public.ledger_inflow li
      on li.business_date >= w.s and li.business_date <= w.e
     and li.is_new_sale and li.product_tier = 'L1_SILVER'
    group by 1
  )
  select w.lbl, w.d, sp.spend, sp.registrations,
         case when sp.registrations > 0 then sp.spend / sp.registrations end,
         z.a60,
         case when z.a60 > 0 then sp.spend / z.a60 end,
         a.n, s.n
  from w
  join spend sp on sp.lbl = w.lbl
  join zoom z on z.lbl = w.lbl
  join adsets a on a.lbl = w.lbl
  join sales s on s.lbl = w.lbl
$function$;

-- 2. paid-attributed sales for the two efficiency ratios
DROP FUNCTION IF EXISTS public.metric_components(date, date);
CREATE FUNCTION public.metric_components(p_start date, p_end date)
 RETURNS TABLE(date date, spend numeric, measured_spend numeric, registrations bigint, registrants bigint, attendees bigint, attendees_matched bigint, sessions_without_registrants bigint, at_60 bigint, sales bigint, paid_sales bigint, collected numeric, has_meta boolean, has_zoom boolean, has_ledger boolean, tm_sales bigint, ledger_sales bigint, has_tm boolean, ledger_settling boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH d AS (
    SELECT g::date AS date
    FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
  ),
  meta AS (
    SELECT m.date,
           SUM(m.spend)::numeric AS spend,
           SUM(m.spend) FILTER (WHERE a.lead_tracking_status = 'working')::numeric AS measured_spend,
           SUM(m.leads) FILTER (WHERE a.lead_tracking_status = 'working')::bigint AS registrations,
           count(*)::bigint AS rows_n
    FROM public.daily_metrics m
    JOIN public.ad_accounts a ON a.account_id = m.account_id
    WHERE m.level = 'account' AND m.date BETWEEN p_start AND p_end
    GROUP BY m.date
  ),
  zoom AS (
    SELECT z.event_date AS date,
           SUM(z.registrants)::bigint AS registrants,
           SUM(z.attendees)::bigint AS attendees,
           SUM(z.attendees_matched)::bigint AS attendees_matched,
           SUM(z.sessions_without_registrants)::bigint AS sessions_without_registrants,
           SUM(z.at_60)::bigint AS at_60,
           count(*)::bigint AS rows_n
    FROM public.zoom_event_rows(p_start, p_end, false) z
    GROUP BY z.event_date
  ),
  tm AS (
    SELECT e.business_date AS date,
           count(DISTINCT e.person_key)::bigint AS sales,
           count(DISTINCT e.person_key) FILTER (
             WHERE EXISTS (SELECT 1 FROM public.lead_attribution la
                            WHERE la.email_key = e.person_key AND la.is_paid)
           )::bigint AS paid_sales,
           count(*)::bigint AS rows_n
    FROM public.tm_enrolments e
    JOIN public.products p ON p.mango_id = e.mango_id AND p.counts_as_sale
    WHERE e.business_date BETWEEN p_start AND p_end
    GROUP BY e.business_date
  ),
  led AS (
    SELECT l.business_date AS date,
           count(*) FILTER (WHERE l.is_new_sale)::bigint AS sales,
           SUM(l.amount_received)::numeric AS collected,
           count(*)::bigint AS rows_n
    FROM public.ledger_inflow l
    WHERE l.product_tier = 'L1_SILVER' AND l.business_date BETWEEN p_start AND p_end
    GROUP BY l.business_date
  )
  SELECT d.date,
         meta.spend, meta.measured_spend, meta.registrations,
         zoom.registrants, zoom.attendees, zoom.attendees_matched,
         COALESCE(zoom.sessions_without_registrants, 0),
         zoom.at_60,
         tm.sales, tm.paid_sales,
         led.collected,
         COALESCE(meta.rows_n, 0) > 0,
         COALESCE(zoom.rows_n, 0) > 0,
         COALESCE(led.rows_n, 0) > 0,
         tm.sales, led.sales,
         COALESCE(tm.rows_n, 0) > 0,
         (
           (public.business_date(now()) - d.date) < 3
           AND NOT (
             COALESCE(tm.sales, 0) > 0
             AND abs(COALESCE(led.sales, 0) - tm.sales)::numeric <= 0.2 * tm.sales
           )
         ) AS ledger_settling
  FROM d
  LEFT JOIN meta ON meta.date = d.date
  LEFT JOIN zoom ON zoom.date = d.date
  LEFT JOIN tm   ON tm.date   = d.date
  LEFT JOIN led  ON led.date  = d.date
  ORDER BY d.date
$function$;
REVOKE ALL ON FUNCTION public.metric_components(date,date) FROM public;
GRANT EXECUTE ON FUNCTION public.metric_components(date,date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.metric_series(p_start date, p_end date, p_grain text DEFAULT 'day'::text)
 RETURNS TABLE(period_start date, metric_id text, value numeric, denom numeric, rupees numeric, complete boolean, days bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH c AS (SELECT * FROM public.metric_components(p_start, p_end)),
  pd AS (SELECT * FROM public.ledger_paid_daily(p_start, p_end)),
  b AS (
    SELECT
      CASE p_grain
        WHEN 'week'  THEN date_trunc('week',  c.date)::date
        WHEN 'month' THEN date_trunc('month', c.date)::date
        ELSE c.date
      END AS period_start,
      count(*)::bigint AS days,
      SUM(c.spend) AS spend,
      SUM(c.measured_spend) AS measured_spend,
      SUM(c.registrations) AS registrations,
      SUM(c.registrants) AS registrants,
      SUM(c.attendees) AS attendees,
      SUM(c.attendees_matched) AS attendees_matched,
      SUM(c.sessions_without_registrants) AS sessions_excluded,
      SUM(c.at_60) AS at_60,
      SUM(c.sales) AS sales,
      SUM(c.paid_sales) AS paid_sales,
      SUM(c.collected) AS collected,
      SUM(pd.collected_paid_exgst) AS paid_exgst,
      bool_and(c.has_meta) AS all_meta,
      bool_and(c.has_ledger) AS all_ledger,
      bool_and(c.has_tm) AS all_tm,
      bool_or(c.ledger_settling) AS any_settling,
      bool_or(c.has_zoom) AS any_zoom
    FROM c LEFT JOIN pd ON pd.business_date = c.date GROUP BY 1
  )
  SELECT * FROM (
    SELECT b.period_start, 'meta_spend'::text, b.spend, NULL::numeric,
           COALESCE(b.spend,0), b.all_meta, b.days FROM b
    UNION ALL
    SELECT b.period_start, 'registrations', b.registrations::numeric, NULL,
           COALESCE(b.measured_spend,0), b.all_meta, b.days FROM b
    UNION ALL
    SELECT b.period_start, 'cost_per_registration',
           CASE WHEN COALESCE(b.registrations,0) > 0 THEN b.measured_spend / b.registrations END,
           b.registrations::numeric, COALESCE(b.measured_spend,0), b.all_meta, b.days FROM b
    UNION ALL
    SELECT b.period_start, 'show_up_rate',
           CASE WHEN COALESCE(b.registrants,0) > 0 THEN 100.0 * b.attendees_matched / b.registrants END,
           b.registrants::numeric, COALESCE(b.spend,0),
           (b.any_zoom AND COALESCE(b.sessions_excluded,0) = 0), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'retention_60',
           CASE WHEN COALESCE(b.attendees,0) > 0 THEN 100.0 * b.at_60 / b.attendees END,
           b.attendees::numeric, COALESCE(b.spend,0), b.any_zoom, b.days FROM b
    UNION ALL
    SELECT b.period_start, 'sales_per_1000_leads',
           CASE WHEN COALESCE(b.registrations,0) > 0 THEN 1000.0 * b.paid_sales / b.registrations END,
           b.registrations::numeric, COALESCE(b.collected,0), (b.all_meta AND b.all_tm), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'cost_per_sale',
           CASE WHEN COALESCE(b.paid_sales,0) > 0 THEN b.measured_spend / b.paid_sales END,
           b.paid_sales::numeric, COALESCE(b.spend,0), (b.all_meta AND b.all_tm), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'front_end_roas',
           CASE WHEN COALESCE(b.spend,0) > 0 THEN b.paid_exgst / b.spend END,
           NULL, COALESCE(b.paid_exgst,0) + COALESCE(b.spend,0),
           (b.all_meta AND b.all_ledger AND NOT b.any_settling), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'paid_collected_exgst', b.paid_exgst, NULL,
           COALESCE(b.paid_exgst,0), (b.all_ledger AND NOT b.any_settling), b.days FROM b
    UNION ALL
    SELECT b.period_start, 'collected', b.collected, NULL,
           COALESCE(b.collected,0), (b.all_ledger AND NOT b.any_settling), b.days FROM b
  ) x
  ORDER BY 2, 1
$function$;