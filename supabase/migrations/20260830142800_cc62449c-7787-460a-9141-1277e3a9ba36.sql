CREATE TABLE public.reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  for_date date NOT NULL,
  primary_value numeric,
  primary_source text NOT NULL,
  witness_value numeric,
  witness_source text NOT NULL,
  divergence_pct numeric,
  verdict text NOT NULL CHECK (verdict IN ('match','tolerable','diverged','witness_unavailable')),
  note text,
  UNIQUE (check_id, for_date)
);

GRANT SELECT ON public.reconciliations TO authenticated;
GRANT ALL ON public.reconciliations TO service_role;

ALTER TABLE public.reconciliations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read reconciliations"
  ON public.reconciliations FOR SELECT TO authenticated USING (true);
CREATE POLICY "Service role manages reconciliations"
  ON public.reconciliations FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX reconciliations_check_date_idx ON public.reconciliations (check_id, for_date DESC);

-- One idempotent write path for the runner: re-checking a day overwrites that
-- day's verdict rather than piling up rows.
CREATE OR REPLACE FUNCTION public.record_reconciliations(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare n integer;
begin
  insert into public.reconciliations
    (check_id, checked_at, for_date, primary_value, primary_source,
     witness_value, witness_source, divergence_pct, verdict, note)
  select r.check_id, coalesce(r.checked_at, now()), r.for_date, r.primary_value, r.primary_source,
         r.witness_value, r.witness_source, r.divergence_pct, r.verdict, r.note
    from jsonb_to_recordset(p_rows) as r(
      check_id text, checked_at timestamptz, for_date date,
      primary_value numeric, primary_source text,
      witness_value numeric, witness_source text,
      divergence_pct numeric, verdict text, note text)
  on conflict (check_id, for_date) do update set
    checked_at = excluded.checked_at,
    primary_value = excluded.primary_value,
    primary_source = excluded.primary_source,
    witness_value = excluded.witness_value,
    witness_source = excluded.witness_source,
    divergence_pct = excluded.divergence_pct,
    verdict = excluded.verdict,
    note = excluded.note;
  get diagnostics n = row_count;
  return n;
end $$;

-- Everything the daily checks need from our own tables, one row per day.
-- Meta spend is restricted to ACTIVE accounts because those are the only
-- accounts the sync pulls: a witness must cover the same population.
CREATE OR REPLACE FUNCTION public.proof_inputs(p_start date, p_end date)
RETURNS TABLE(
  date date,
  meta_spend numeric,
  tm_sales bigint,
  ledger_sales bigint,
  settled boolean,
  leads_registered bigint,
  zoom_registrants bigint,
  zoom_valid_participants bigint,
  zoom_total_attendees bigint,
  zoom_sessions_n bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH d AS (
    SELECT g::date AS date
    FROM generate_series(p_start::timestamp, p_end::timestamp, interval '1 day') g
  ),
  mc AS (SELECT * FROM public.metric_components(p_start, p_end)),
  meta AS (
    SELECT m.date, sum(m.spend)::numeric AS spend
      FROM public.daily_metrics m
      JOIN public.ad_accounts a ON a.account_id = m.account_id
     WHERE m.level = 'account' AND a.is_active AND m.date BETWEEN p_start AND p_end
     GROUP BY m.date
  ),
  lead AS (
    SELECT l.business_date AS date, count(*) FILTER (WHERE l.is_registered)::bigint AS n
      FROM public.leads l
     WHERE l.business_date BETWEEN p_start AND p_end
     GROUP BY l.business_date
  ),
  zs AS (
    SELECT z.business_date AS date,
           sum(z.total_registrants)::bigint AS registrants,
           sum(z.total_attendees)::bigint AS attendees,
           count(*)::bigint AS sessions_n
      FROM public.zoom_sessions z
     WHERE z.business_date BETWEEN p_start AND p_end
       AND z.total_attendees IS NOT NULL
     GROUP BY z.business_date
  ),
  -- Distinct valid participants counted PER SESSION and then summed, so the two
  -- computation paths measure the same thing; a day-wide distinct would differ
  -- from total_attendees for the honest reason that people attend both slots.
  zp AS (
    SELECT s.business_date AS date, sum(s.n)::bigint AS n
      FROM (
        SELECT z.business_date,
               count(DISTINCT coalesce(nullif(lower(p.email), ''), p.participant_id, p.name))::bigint AS n
          FROM public.zoom_participants p
          JOIN public.zoom_sessions z ON z.session_uuid = p.session_uuid
         WHERE p.is_valid
           AND z.business_date BETWEEN p_start AND p_end
           AND z.total_attendees IS NOT NULL
         GROUP BY z.business_date, z.session_uuid
      ) s
     GROUP BY s.business_date
  )
  SELECT d.date,
         meta.spend,
         mc.tm_sales,
         mc.ledger_sales,
         NOT coalesce(mc.ledger_settling, true) AS settled,
         lead.n,
         zs.registrants,
         zp.n,
         zs.attendees,
         coalesce(zs.sessions_n, 0)
    FROM d
    LEFT JOIN mc   ON mc.date   = d.date
    LEFT JOIN meta ON meta.date = d.date
    LEFT JOIN lead ON lead.date = d.date
    LEFT JOIN zs   ON zs.date   = d.date
    LEFT JOIN zp   ON zp.date   = d.date
   ORDER BY d.date
$$;

-- History must never move silently: the agreed closed-month counts, re-derived
-- from the ledger exactly as it stands right now.
CREATE OR REPLACE FUNCTION public.proof_closed_months()
RETURNS TABLE(month_start date, month text, baseline numeric, ledger_sales bigint)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH b AS (
    SELECT key AS month, value::numeric AS baseline
      FROM jsonb_each_text(
        (SELECT coalesce(value, '{}')::jsonb FROM public.app_settings WHERE key = 'ledger_baseline_monthly')
      ) AS t(key, value)
  )
  SELECT (b.month || '-01')::date AS month_start,
         b.month,
         b.baseline,
         (SELECT count(*) FILTER (WHERE l.is_new_sale)::bigint
            FROM public.ledger_inflow l
           WHERE l.product_tier = 'L1_SILVER'
             AND to_char(l.business_date, 'YYYY-MM') = b.month) AS ledger_sales
    FROM b
   ORDER BY b.month
$$;

-- What /trust reads: one row per check, from that check's most recent run.
CREATE OR REPLACE FUNCTION public.proof_summary()
RETURNS TABLE(
  check_id text,
  label text,
  plain text,
  primary_source text,
  witness_source text,
  last_run timestamptz,
  hours_since numeric,
  days_checked integer,
  matches integer,
  tolerable integer,
  diverged integer,
  unavailable integer,
  worst_date date,
  worst_divergence numeric,
  worst_primary numeric,
  worst_witness numeric,
  worst_note text,
  status text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH reg(check_id, label, plain, ord) AS (
    VALUES
      ('meta_spend', 'Meta spend', 'What we stored for each day against a fresh call to Meta''s own API for that day.', 1),
      ('sales_count', 'Sales count', 'TagMango enrolments against the accounts ledger''s New Sale count, on settled days only.', 2),
      ('registrations', 'Registrations', 'Registered leads in the CRM against registrants recorded by the webinar platform.', 3),
      ('attendance_integrity', 'Attendance arithmetic', 'Our own two ways of counting the same Zoom attendance, to catch aggregation bugs.', 4),
      ('ledger_closed_months', 'Closed months', 'The agreed January–July sale counts, re-asserted against the ledger every day.', 5)
  ),
  last AS (
    SELECT r.check_id, max(r.checked_at) AS last_run
      FROM public.reconciliations r GROUP BY r.check_id
  ),
  cur AS (
    SELECT r.*
      FROM public.reconciliations r
      JOIN last ON last.check_id = r.check_id
     WHERE r.checked_at > last.last_run - interval '2 hours'
  ),
  agg AS (
    SELECT c.check_id,
           count(*)::int AS days_checked,
           count(*) FILTER (WHERE c.verdict = 'match')::int AS matches,
           count(*) FILTER (WHERE c.verdict = 'tolerable')::int AS tolerable,
           count(*) FILTER (WHERE c.verdict = 'diverged')::int AS diverged,
           count(*) FILTER (WHERE c.verdict = 'witness_unavailable')::int AS unavailable,
           (array_agg(c.primary_source ORDER BY c.for_date DESC))[1] AS primary_source,
           (array_agg(c.witness_source ORDER BY c.for_date DESC))[1] AS witness_source
      FROM cur c GROUP BY c.check_id
  ),
  worst AS (
    SELECT DISTINCT ON (c.check_id)
           c.check_id, c.for_date, c.divergence_pct, c.primary_value, c.witness_value, c.note
      FROM cur c
     ORDER BY c.check_id, abs(coalesce(c.divergence_pct, 0)) DESC, c.for_date DESC
  )
  SELECT reg.check_id,
         reg.label,
         reg.plain,
         agg.primary_source,
         agg.witness_source,
         last.last_run,
         CASE WHEN last.last_run IS NULL THEN NULL
              ELSE round(extract(epoch FROM (now() - last.last_run)) / 3600.0, 2) END,
         coalesce(agg.days_checked, 0),
         coalesce(agg.matches, 0),
         coalesce(agg.tolerable, 0),
         coalesce(agg.diverged, 0),
         coalesce(agg.unavailable, 0),
         worst.for_date,
         worst.divergence_pct,
         worst.primary_value,
         worst.witness_value,
         worst.note,
         CASE
           WHEN last.last_run IS NULL THEN 'never_run'
           WHEN extract(epoch FROM (now() - last.last_run)) / 3600.0 > 48 THEN 'stale'
           WHEN coalesce(agg.diverged, 0) > 0 THEN 'diverged'
           WHEN coalesce(agg.matches, 0) + coalesce(agg.tolerable, 0) = 0 THEN 'unverified'
           ELSE 'match'
         END
    FROM reg
    LEFT JOIN last ON last.check_id = reg.check_id
    LEFT JOIN agg  ON agg.check_id  = reg.check_id
    LEFT JOIN worst ON worst.check_id = reg.check_id
   ORDER BY reg.ord
$$;

-- The detail behind the summary: the rows written by each check's latest run.
CREATE OR REPLACE FUNCTION public.proof_detail(p_days integer)
RETURNS TABLE(
  check_id text,
  for_date date,
  checked_at timestamptz,
  primary_value numeric,
  primary_source text,
  witness_value numeric,
  witness_source text,
  divergence_pct numeric,
  verdict text,
  note text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.check_id, r.for_date, r.checked_at, r.primary_value, r.primary_source,
         r.witness_value, r.witness_source, r.divergence_pct, r.verdict, r.note
    FROM public.reconciliations r
   WHERE r.for_date >= current_date - coalesce(p_days, 14)
      OR r.check_id = 'ledger_closed_months'
   ORDER BY r.check_id, r.for_date DESC
$$;

-- The watchdog is itself watched: proof checks are a feed like any other.
INSERT INTO public.feed_config (feed, label, cadence_hours, is_blocking, sources, note)
VALUES ('proof', 'Proof checks', 24, false, ARRAY['proof'],
        'Cross-checks every headline number against an independent witness')
ON CONFLICT (feed) DO UPDATE SET
  label = excluded.label,
  cadence_hours = excluded.cadence_hours,
  sources = excluded.sources,
  note = excluded.note;

-- feed_health_rows learns where the proof feed's coverage edge lives.
CREATE OR REPLACE FUNCTION public.feed_health_rows()
 RETURNS TABLE(feed text, label text, cadence_hours numeric, is_blocking boolean, last_success timestamp with time zone, last_run timestamp with time zone, last_run_status text, running_since timestamp with time zone, hours_since_success numeric, coverage_edge date, coverage_lag_days numeric, consecutive_failures integer, last_error text, status text, rows_last_run integer, warning text, warning_level text, expires_at date, days_to_expiry integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_expiry date;
  v_days integer;
begin
  perform public.reap_abandoned_runs();

  select nullif(btrim(s.value), '')::date into v_expiry
    from app_settings s where s.key = 'meta_token_expires_at';
  v_days := case when v_expiry is null then null else (v_expiry - current_date) end;

  return query
  with runs as (
    select f.feed,
           max(r.finished_at) filter (where r.status in ('success','ok','partial')) as last_success,
           max(r.started_at) as last_run,
           max(r.started_at) filter (where r.status = 'running' and r.finished_at is null) as running_since
      from feed_config f
      left join sync_runs r on r.source = any(f.sources)
     group by f.feed
  ),
  latest as (
    select f.feed,
           (array_agg(r.status order by r.started_at desc))[1] as last_run_status,
           (array_agg(r.error order by r.started_at desc))[1] as last_error,
           (array_agg(r.rows_written order by r.started_at desc))[1] as rows_last_run
      from feed_config f
      left join sync_runs r on r.source = any(f.sources)
     group by f.feed
  ),
  fails as (
    select f.feed, count(*)::int as consecutive_failures
      from feed_config f
      left join sync_runs r on r.source = any(f.sources)
       and r.started_at > coalesce((select max(x.finished_at) from sync_runs x where x.source = any(f.sources) and x.status in ('success','ok','partial')), '-infinity'::timestamptz)
       and r.status in ('error','abandoned')
     group by f.feed
  ),
  cov as (
    select f.feed,
           case f.feed
             when 'meta_ads' then (select max(d.date) from daily_metrics d where d.level = 'account')
             when 'zoom' then (select max(z.business_date) from zoom_sessions z)
             when 'ledger' then (select max(l.business_date) from ledger_inflow l)
             when 'tm_payments' then (select max(p.business_date) from tm_payments p)
             when 'tm_products' then (select max(pr.last_synced_at)::date from products pr)
             when 'leads' then (select max(le.business_date) from leads le)
             when 'proof' then (select max(rc.checked_at)::date from reconciliations rc)
           end as coverage_edge
      from feed_config f
  )
  select f.feed,
         f.label,
         f.cadence_hours,
         f.is_blocking,
         r.last_success,
         r.last_run,
         l.last_run_status,
         r.running_since,
         case when r.last_success is null then null
              else round(extract(epoch from (now() - r.last_success)) / 3600.0, 2) end,
         c.coverage_edge,
         case when c.coverage_edge is null then null
              else (current_date - c.coverage_edge)::numeric end,
         coalesce(fl.consecutive_failures, 0),
         l.last_error,
         case
           when r.last_success is null then 'broken'
           when r.running_since is not null and r.running_since < now() - (f.cadence_hours * 2 || ' hours')::interval then 'broken'
           when extract(epoch from (now() - r.last_success)) / 3600.0 > f.cadence_hours * 3 then 'broken'
           when c.coverage_edge is null then 'broken'
           when (current_date - c.coverage_edge) > (f.cadence_hours / 24.0) + 3 then 'broken'
           when extract(epoch from (now() - r.last_success)) / 3600.0 > f.cadence_hours * 2 then 'stale'
           when (current_date - c.coverage_edge) > (f.cadence_hours / 24.0) + 1.5 then 'stale'
           when extract(epoch from (now() - r.last_success)) / 3600.0 > f.cadence_hours * 1.25 then 'late'
           else 'live'
         end,
         l.rows_last_run,
         case when f.feed = 'meta_ads' and v_days is not null and v_days <= 30
              then 'The Meta connection expires in ' || v_days || ' day' || case when v_days = 1 then '' else 's' end
                   || '. Renewing takes 10 minutes; losing it silently costs days of data.'
              end,
         case when f.feed = 'meta_ads' and v_days is not null and v_days <= 7 then 'critical'
              when f.feed = 'meta_ads' and v_days is not null and v_days <= 30 then 'warning'
              end,
         case when f.feed = 'meta_ads' then v_expiry end,
         case when f.feed = 'meta_ads' then v_days end
    from feed_config f
    join runs r on r.feed = f.feed
    join latest l on l.feed = f.feed
    left join fails fl on fl.feed = f.feed
    left join cov c on c.feed = f.feed
   order by f.is_blocking desc, f.feed;
end $function$;