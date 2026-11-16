-- ============ 1. Atomic, self-checking sales rollup ============

CREATE OR REPLACE FUNCTION public.rebuild_tm_sales()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_count integer;
BEGIN
  -- Serialise rebuilds: two overlapping sync passes must never interleave.
  PERFORM pg_advisory_xact_lock(hashtext('rebuild_tm_sales'));

  CREATE TEMP TABLE _tm_sales_next ON COMMIT DROP AS
  WITH enrolled AS (
    SELECT
      e.person_key, e.subscription_id, e.mango_id, pr.payment_route,
      e.enrolled_at, e.amount_via_tagmango, e.coupon_code, e.is_coupon
    FROM public.tm_enrolments e
    JOIN public.products pr ON pr.mango_id = e.mango_id
    WHERE pr.tier = 'L1_SILVER' AND pr.counts_as_sale
      AND e.person_key <> '' AND e.enrolled_at IS NOT NULL
  ), ordered AS (
    SELECT x.*, lag(x.enrolled_at) OVER (PARTITION BY x.person_key ORDER BY x.enrolled_at) AS prev_at
    FROM enrolled x
  ), marked AS (
    SELECT o.*,
      sum(CASE WHEN o.prev_at IS NULL OR o.enrolled_at > o.prev_at + interval '120 days' THEN 1 ELSE 0 END)
        OVER (PARTITION BY o.person_key ORDER BY o.enrolled_at ROWS UNBOUNDED PRECEDING) AS cohort
    FROM ordered o
  ), grouped AS (
    SELECT
      person_key, cohort,
      min(enrolled_at) AS first_at,
      count(*) AS enrolment_count,
      sum(amount_via_tagmango) AS amount_via_tagmango,
      bool_or(is_coupon) AS is_coupon,
      (array_agg(coupon_code) FILTER (WHERE coupon_code IS NOT NULL))[1] AS coupon_code,
      bool_or(payment_route LIKE 'BMS%') AS has_bms,
      bool_or(payment_route = 'EMI') AS has_emi,
      (array_agg(mango_id ORDER BY enrolled_at))[1] AS first_mango_id
    FROM marked
    GROUP BY person_key, cohort
  ), priced AS (
    SELECT
      g.*,
      GREATEST(
        g.amount_via_tagmango,
        COALESCE((
          SELECT sum(p.amount_gross)
          FROM public.tm_payments p
          JOIN public.products pp ON pp.mango_id = p.mango_id
          WHERE lower(btrim(p.buyer_email)) = g.person_key
            AND pp.tier = 'L1_SILVER' AND pp.counts_as_sale
            AND lower(coalesce(p.status,'')) IN ('completed','captured','success','successful','paid','active')
            AND p.paid_at >= g.first_at - interval '7 days'
            AND p.paid_at <= g.first_at + interval '120 days'
        ), 0)
      ) AS tm_amount,
      (
        SELECT (p2.raw->>'coupon')
        FROM public.tm_payments p2
        WHERE lower(btrim(p2.buyer_email)) = g.person_key
          AND p2.raw->>'coupon' IS NOT NULL
          AND p2.paid_at >= g.first_at - interval '7 days'
          AND p2.paid_at <= g.first_at + interval '120 days'
        ORDER BY p2.paid_at LIMIT 1
      ) AS payment_coupon
    FROM grouped g
  )
  SELECT
    person_key,
    first_at AS first_payment_at,
    public.business_date(first_at) AS business_date,
    (CASE WHEN has_bms THEN 'BMS' WHEN has_emi THEN 'EMI' ELSE 'FULL' END)::text AS payment_route,
    tm_amount AS gross_collected,
    tm_amount AS amount_via_tagmango,
    NULL::numeric AS amount_via_ledger,
    (CASE WHEN tm_amount >= 6900 THEN 'TAGMANGO' ELSE 'UNRECONCILED' END)::text AS revenue_source,
    (CASE
      WHEN tm_amount >= 6900 THEN 'MATCHED'
      WHEN is_coupon OR coupon_code IS NOT NULL OR payment_coupon IS NOT NULL OR tm_amount = 0
        THEN 'AWAITING_LEDGER'
      ELSE 'SHORTFALL'
    END)::text AS revenue_status,
    (is_coupon OR coupon_code IS NOT NULL OR payment_coupon IS NOT NULL) AS is_coupon,
    COALESCE(coupon_code, payment_coupon) AS coupon_code,
    6990::numeric AS expected_gross,
    (tm_amount >= 6900) AS is_fully_paid,
    enrolment_count AS payment_count,
    enrolment_count,
    first_mango_id
  FROM priced;

  -- Swap: both statements land in one transaction, so no reader ever observes
  -- a partly-built table.
  DELETE FROM public.tm_sales WHERE true;
  INSERT INTO public.tm_sales (
    person_key, first_payment_at, business_date, payment_route,
    gross_collected, amount_via_tagmango, amount_via_ledger, revenue_source, revenue_status,
    is_coupon, coupon_code, expected_gross, is_fully_paid, payment_count, enrolment_count,
    first_mango_id, updated_at)
  SELECT person_key, first_payment_at, business_date, payment_route,
    gross_collected, amount_via_tagmango, amount_via_ledger, revenue_source, revenue_status,
    is_coupon, coupon_code, expected_gross, is_fully_paid, payment_count, enrolment_count,
    first_mango_id, now()
  FROM _tm_sales_next;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

-- Invariant: sales in a period must track distinct buyers who transacted in it.
CREATE OR REPLACE FUNCTION public.tm_sales_coverage(p_start date, p_end date)
 RETURNS TABLE(period text, buyers bigint, sales bigint, coverage_pct numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH b AS (
    SELECT to_char(public.business_date(t.at), 'YYYY-MM') AS period,
           count(DISTINCT t.person_key) AS buyers
    FROM (
      SELECT lower(btrim(p.buyer_email)) AS person_key, p.paid_at AS at
      FROM public.tm_payments p
      JOIN public.products pr ON pr.mango_id = p.mango_id
      WHERE pr.tier = 'L1_SILVER' AND pr.counts_as_sale
        AND p.paid_at IS NOT NULL AND btrim(coalesce(p.buyer_email,'')) <> ''
      UNION
      SELECT e.person_key, e.enrolled_at
      FROM public.tm_enrolments e
      JOIN public.products pr ON pr.mango_id = e.mango_id
      WHERE pr.tier = 'L1_SILVER' AND pr.counts_as_sale AND e.enrolled_at IS NOT NULL
    ) t
    WHERE public.business_date(t.at) BETWEEN p_start AND p_end
    GROUP BY 1
  ), s AS (
    SELECT to_char(business_date, 'YYYY-MM') AS period, count(*) AS sales
    FROM public.tm_sales
    WHERE business_date BETWEEN p_start AND p_end
    GROUP BY 1
  )
  SELECT COALESCE(b.period, s.period),
         COALESCE(b.buyers, 0),
         COALESCE(s.sales, 0),
         CASE WHEN COALESCE(b.buyers,0) = 0 THEN NULL
              ELSE round(100.0 * COALESCE(s.sales,0) / b.buyers, 1) END
  FROM b FULL JOIN s ON s.period = b.period
  ORDER BY 1
$function$;

-- ============ 2. Zoom: explicit attendance status + live/replay roles ============

ALTER TABLE public.zoom_sessions
  ADD COLUMN IF NOT EXISTS participants_status text NOT NULL DEFAULT 'unavailable',
  ADD COLUMN IF NOT EXISTS participants_note text,
  ADD COLUMN IF NOT EXISTS session_role text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS topic_date date,
  ADD COLUMN IF NOT EXISTS event_key text;

CREATE INDEX IF NOT EXISTS zoom_sessions_event_key_idx ON public.zoom_sessions (event_key);
CREATE INDEX IF NOT EXISTS zoom_sessions_role_idx ON public.zoom_sessions (session_role);

INSERT INTO public.app_settings (key, value, description) VALUES
  ('zoom_topic_rules',
   '{"replay_words":["replay"],"test_words":["test","testing","dummy"],"date_patterns":["dd-mm-yyyy","dd-mm-yy","dd/mm/yyyy","written"],"replay_offset_days":1}',
   'Topic normalisation rules for Zoom sessions: lowercase, collapse whitespace, strip punctuation, then match these words to derive live/replay/test and parse the topic date. Editable without a rebuild.')
ON CONFLICT (key) DO NOTHING;

DROP FUNCTION IF EXISTS public.zoom_session_rows(date, date);
CREATE OR REPLACE FUNCTION public.zoom_session_rows(
  p_start date, p_end date, p_include_test boolean DEFAULT false)
 RETURNS TABLE(session_uuid text, zoom_id text, session_type text, topic text,
   start_time timestamp with time zone, business_date date, duration_min integer,
   total_registrants integer, attendees bigint, invalid_rows bigint,
   at_30 bigint, at_60 bigint, at_90 bigint,
   session_role text, topic_date date, event_key text,
   participants_status text, participants_note text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    s.session_uuid, s.zoom_id, s.session_type, s.topic, s.start_time, s.business_date,
    s.duration_min, s.total_registrants,
    (select count(*) from public.zoom_attendance a where a.session_uuid = s.session_uuid),
    (select count(*) from public.zoom_participants p
      where p.session_uuid = s.session_uuid and p.is_valid = false),
    (select count(*) from public.zoom_attendance a
      where a.session_uuid = s.session_uuid
        and a.first_join <= s.start_time + interval '30 minutes'
        and a.last_leave >= s.start_time + interval '30 minutes'),
    (select count(*) from public.zoom_attendance a
      where a.session_uuid = s.session_uuid
        and a.first_join <= s.start_time + interval '60 minutes'
        and a.last_leave >= s.start_time + interval '60 minutes'),
    (select count(*) from public.zoom_attendance a
      where a.session_uuid = s.session_uuid
        and a.first_join <= s.start_time + interval '90 minutes'
        and a.last_leave >= s.start_time + interval '90 minutes'),
    s.session_role, s.topic_date, s.event_key, s.participants_status, s.participants_note
  from public.zoom_sessions s
  where s.business_date >= p_start and s.business_date <= p_end
    and (p_include_test or s.session_role <> 'test')
  order by s.start_time desc
$function$;

-- Live + replay of the same webinar collapsed into one logical event.
CREATE OR REPLACE FUNCTION public.zoom_event_rows(
  p_start date, p_end date, p_include_test boolean DEFAULT false)
 RETURNS TABLE(event_key text, event_date date, sessions bigint, live_sessions bigint,
   replay_sessions bigint, registrants bigint, attendees bigint,
   at_30 bigint, at_60 bigint, at_90 bigint,
   sessions_missing_attendance bigint, first_start timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with s as (
    select * from public.zoom_sessions z
    where z.event_key is not null
      and z.event_key >= to_char(p_start,'YYYY-MM-DD')
      and z.event_key <= to_char(p_end,'YYYY-MM-DD')
      and (p_include_test or z.session_role <> 'test')
  ), per as (
    select
      s.event_key,
      s.session_uuid,
      s.start_time,
      s.session_role,
      -- registrants belong to the webinar definition, so count them once per
      -- zoom_id inside the event, never once per row.
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
    coalesce(sum(per.a30),0)::bigint,
    coalesce(sum(per.a60),0)::bigint,
    coalesce(sum(per.a90),0)::bigint,
    count(*) filter (where per.participants_status in ('failed','unavailable'))::bigint,
    min(per.start_time)
  from per
  group by per.event_key
  order by per.event_key desc
$function$;