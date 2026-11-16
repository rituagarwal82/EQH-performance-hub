-- ═══ STEP 1 — YIELD-AWARE SYNC STATUS ═══

alter table public.sync_runs
  add column if not exists expected_rows numeric,
  add column if not exists yield_verdict text,
  add column if not exists yield_note text;

alter table public.sync_runs drop constraint if exists sync_runs_yield_verdict_check;
alter table public.sync_runs add constraint sync_runs_yield_verdict_check
  check (yield_verdict is null or yield_verdict in
    ('normal','high','low','zero_plausible','zero_anomalous','unknown'));

create table if not exists public.sync_yield_rules (
  source text primary key,
  min_factor numeric not null default 0.25,
  max_factor numeric not null default 4.0,
  zero_policy text not null default 'never_plausible'
    check (zero_policy in ('never_plausible','plausible_if_off_day','always_plausible')),
  lookback_days integer not null default 28,
  note text,
  updated_at timestamptz not null default now()
);

grant select on public.sync_yield_rules to authenticated;
grant all on public.sync_yield_rules to service_role;
alter table public.sync_yield_rules enable row level security;

drop policy if exists "yield rules readable by authenticated" on public.sync_yield_rules;
create policy "yield rules readable by authenticated"
  on public.sync_yield_rules for select to authenticated using (true);
drop policy if exists "yield rules writable by service role" on public.sync_yield_rules;
create policy "yield rules writable by service role"
  on public.sync_yield_rules for all to service_role using (true) with check (true);

insert into public.sync_yield_rules (source, min_factor, max_factor, zero_policy, note) values
  ('tagmango-payments', 0.10, 6.0, 'never_plausible',
   'Trailing-30d median 309 rows. The business sells about 8 L1 a day, so a zero-row pass is never plausible.'),
  ('cron', 0.25, 4.0, 'never_plausible',
   'Trailing-30d median 821 rows. Extra rule: yesterday must be covered for every account that spent yesterday.'),
  ('cron-ads', 0.20, 4.0, 'never_plausible',
   'Trailing-30d median 1,146 rows. Extra rule: yesterday must be covered for every account that spent yesterday.'),
  ('ghl-leads', 0.15, 5.0, 'never_plausible',
   'Trailing-30d median 1,398 rows.'),
  ('ledger', 0.25, 4.0, 'never_plausible',
   'Trailing-30d median 2,086 rows. Extra rule: yesterday needs at least 30% of the trailing same-weekday row count, else the day is still settling, not covered.'),
  ('zoom-cron', 0.25, 4.0, 'plausible_if_off_day',
   'Trailing-30d median 7,607 rows. Nothing to fetch on a webinar off-day is legitimate.'),
  ('zoom-manual', 0.25, 4.0, 'always_plausible', 'Hand-run backfill.'),
  ('tagmango-products', 0.25, 4.0, 'always_plausible',
   'Trailing-30d median 132 rows. The catalogue changes rarely, so no change is normal.'),
  ('proof', 0.25, 6.0, 'never_plausible',
   'Every proof run writes reconciliation rows; a run that writes none did not check anything.'),
  ('analyst-brief', 0.25, 4.0, 'never_plausible',
   'One brief per run. Zero means no brief was written.')
on conflict (source) do update set
  min_factor = excluded.min_factor, max_factor = excluded.max_factor,
  zero_policy = excluded.zero_policy, note = excluded.note, updated_at = now();

-- Is the given IST business day a declared webinar off-day?
create or replace function public.is_webinar_off_day(p_date date)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    exists (
      select 1
        from app_settings s,
             lateral unnest(string_to_array(coalesce(s.value,''), ',')) as d(v)
       where s.key = 'webinar_off_days'
         and btrim(d.v) <> ''
         and btrim(d.v)::date = p_date
    ), false)
$$;

-- Accounts that spent in the week before p_date but have no account-level row ON p_date.
create or replace function public.meta_accounts_uncovered(p_date date)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int
    from (
      select distinct d.account_id
        from daily_metrics d
       where d.level = 'account'
         and d.date between p_date - 7 and p_date - 1
         and d.spend > 0
    ) recent
   where not exists (
     select 1 from daily_metrics x
      where x.level = 'account' and x.account_id = recent.account_id and x.date = p_date
   )
$$;

-- Ledger day shortfall: fewer than 30% of the trailing same-weekday median row count.
create or replace function public.ledger_day_short(p_date date)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_day numeric; v_med numeric;
begin
  select count(*) into v_day from ledger_inflow where business_date = p_date;
  select percentile_cont(0.5) within group (order by n) into v_med
    from (
      select count(*)::numeric as n
        from ledger_inflow
       where business_date between p_date - 70 and p_date - 7
         and extract(dow from business_date) = extract(dow from p_date)
       group by business_date
    ) t;
  if v_med is null or v_med = 0 then return false; end if;
  return v_day < 0.3 * v_med;
end $$;

/**
 * The yield judge. The baseline is SELF-EXCLUDING: only runs already judged
 * normal or high count towards the median, so a stuck cursor writing zeros
 * cannot quietly drag its own expectation down to zero.
 */
create or replace function public.judge_yield_of(
  p_source text, p_rows integer, p_run_id uuid, p_at timestamptz
) returns table(expected numeric, verdict text, note text)
language plpgsql stable security definer set search_path = public as $$
declare
  r record; v_med numeric; v_verdict text; v_note text;
  v_boot boolean := false; v_day date; v_ratio numeric; v_uncovered int;
begin
  select * into r from sync_yield_rules where source = p_source;
  if not found then
    return query select null::numeric, 'unknown'::text,
      ('No yield rule is defined for ' || p_source || ', so nothing can be expected of it.')::text;
    return;
  end if;

  v_day := (coalesce(p_at, now()) at time zone 'Asia/Kolkata')::date - 1;

  select percentile_cont(0.5) within group (order by s.rows_written) into v_med
    from sync_runs s
   where s.source = p_source and s.id is distinct from p_run_id
     and s.started_at > coalesce(p_at, now()) - (r.lookback_days || ' days')::interval
     and s.yield_verdict in ('normal','high');

  if v_med is null then
    v_boot := true;
    select percentile_cont(0.5) within group (order by s.rows_written) into v_med
      from sync_runs s
     where s.source = p_source and s.id is distinct from p_run_id
       and s.started_at > coalesce(p_at, now()) - (r.lookback_days || ' days')::interval
       and s.status in ('success','ok','partial') and coalesce(s.rows_written,0) > 0;
  end if;

  if coalesce(p_rows, 0) = 0 then
    if r.zero_policy = 'always_plausible' then
      v_verdict := 'zero_plausible';
      v_note := 'Nothing to fetch is a normal outcome for this source.';
    elsif r.zero_policy = 'plausible_if_off_day' and public.is_webinar_off_day(v_day) then
      v_verdict := 'zero_plausible';
      v_note := to_char(v_day,'DD Mon') || ' is a declared webinar off-day, so no rows is expected.';
    else
      v_verdict := 'zero_anomalous';
      v_note := 'Zero rows written where about ' || coalesce(round(v_med)::text,'some') ||
                ' were expected. This run fetched nothing and must not be called a success.';
    end if;
  elsif v_med is null or v_med = 0 then
    v_verdict := 'unknown';
    v_note := 'No settled baseline yet for this source, so the row count cannot be judged.';
  else
    v_ratio := p_rows::numeric / v_med;
    if v_ratio < r.min_factor then
      v_verdict := 'low';
      v_note := p_rows || ' rows written against an expected ' || round(v_med) ||
                ' — that is ' || round(v_ratio * 100) || '% of the usual yield.';
    elsif v_ratio > r.max_factor then
      v_verdict := 'high';
      v_note := p_rows || ' rows written against an expected ' || round(v_med) ||
                ' — unusually large, worth a glance but not a fault.';
    else
      v_verdict := 'normal';
      v_note := p_rows || ' rows written against an expected ' || round(v_med) || '.';
    end if;
  end if;

  -- Extra source rules. They can only make the verdict worse, never better.
  if p_source in ('cron','cron-ads') and v_verdict in ('normal','high') then
    v_uncovered := public.meta_accounts_uncovered(v_day);
    if v_uncovered > 0 then
      v_verdict := 'low';
      v_note := v_uncovered || ' account' || case when v_uncovered = 1 then '' else 's' end ||
                ' that spent in the past week have no row for ' || to_char(v_day,'DD Mon') ||
                '. The run wrote rows but did not cover yesterday.';
    end if;
  end if;

  if p_source = 'ledger' and v_verdict in ('normal','high') and public.ledger_day_short(v_day) then
    v_verdict := 'low';
    v_note := to_char(v_day,'DD Mon') || ' has far fewer ledger rows than a usual ' ||
              trim(to_char(v_day,'Day')) || '. That day is still settling, not covered.';
  end if;

  if v_boot and v_med is not null then
    v_note := v_note || ' (Baseline bootstrapped from earlier successful runs.)';
  end if;

  return query select round(v_med, 2), v_verdict, v_note;
end $$;

/**
 * Judged the moment a run finishes. A run may only keep the word 'success' if
 * it actually yielded something it was supposed to yield.
 */
create or replace function public.sync_runs_judge_yield()
returns trigger language plpgsql security definer set search_path = public as $$
declare j record;
begin
  if new.finished_at is null then return new; end if;
  if old.finished_at is not null and new.rows_written is not distinct from old.rows_written then
    return new;
  end if;

  select * into j from public.judge_yield_of(
    new.source, coalesce(new.rows_written,0), new.id, coalesce(new.started_at, now()));

  new.expected_rows := j.expected;
  new.yield_verdict := j.verdict;
  new.yield_note := j.note;

  if new.status in ('success','ok')
     and j.verdict not in ('normal','high','zero_plausible') then
    new.status := 'success_no_yield';
  end if;

  return new;
end $$;

drop trigger if exists trg_sync_runs_judge_yield on public.sync_runs;
create trigger trg_sync_runs_judge_yield
  before update of finished_at, rows_written, status on public.sync_runs
  for each row execute function public.sync_runs_judge_yield();

-- Manual/backfill entry point.
create or replace function public.judge_yield(p_run_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare j record; r record;
begin
  select * into r from sync_runs where id = p_run_id;
  if not found then return 'no such run'; end if;
  select * into j from public.judge_yield_of(r.source, coalesce(r.rows_written,0), r.id, r.started_at);
  update sync_runs set expected_rows = j.expected, yield_verdict = j.verdict, yield_note = j.note,
    status = case when status in ('success','ok') and j.verdict not in ('normal','high','zero_plausible')
                  then 'success_no_yield' else status end
   where id = p_run_id;
  return j.verdict;
end $$;

-- 'success_no_yield' is not a success anywhere: it never advances last_success,
-- and it counts as a failure since the last real one.
create or replace view public.sync_health as
 WITH last_ok AS (
         SELECT sync_runs.source, max(COALESCE(sync_runs.finished_at, sync_runs.started_at)) AS at
           FROM sync_runs
          WHERE sync_runs.status = ANY (ARRAY['success'::text,'ok'::text,'partial'::text])
          GROUP BY sync_runs.source
        ), last_any AS (
         SELECT sync_runs.source, max(sync_runs.started_at) AS at FROM sync_runs GROUP BY sync_runs.source
        ), fails AS (
         SELECT r.source, count(*) AS n
           FROM sync_runs r LEFT JOIN last_ok o_1 ON o_1.source = r.source
          WHERE (r.status = ANY (ARRAY['error'::text,'warning'::text,'success_no_yield'::text]))
            AND (o_1.at IS NULL OR r.started_at > o_1.at)
          GROUP BY r.source
        )
 SELECT c.source, c.label, c.cadence_hours, c.is_critical, c.note,
    o.at AS last_success, a.at AS last_run,
    CASE WHEN o.at IS NULL THEN NULL::numeric
         ELSE round(EXTRACT(epoch FROM now() - o.at) / 3600.0, 1) END AS hours_since_success,
    COALESCE(f.n, 0::bigint)::integer AS consecutive_failures,
    ( SELECT r.error FROM sync_runs r
       WHERE r.source = c.source AND r.error IS NOT NULL
       ORDER BY r.started_at DESC LIMIT 1) AS last_error,
    CASE WHEN o.at IS NULL THEN 'dead'::text
         WHEN (EXTRACT(epoch FROM now() - o.at) / 3600.0) >= (c.cadence_hours * 3::numeric) THEN 'dead'::text
         WHEN (EXTRACT(epoch FROM now() - o.at) / 3600.0) >= (c.cadence_hours * 1.5) THEN 'late'::text
         ELSE 'ok'::text END AS status
   FROM sync_source_config c
     LEFT JOIN last_ok o ON o.source = c.source
     LEFT JOIN last_any a ON a.source = c.source
     LEFT JOIN fails f ON f.source = c.source;

-- Recent runs now carry the yield judgement for the health screen.
drop function if exists public.sync_recent_runs(integer);
create or replace function public.sync_recent_runs(p_limit integer default 20)
returns table(source text, started_at timestamptz, finished_at timestamptz, status text,
              rows_written integer, error text, expected_rows numeric,
              yield_verdict text, yield_note text)
language sql stable security definer set search_path = public as $$
  select r.source, r.started_at, r.finished_at, r.status, r.rows_written, r.error,
         r.expected_rows, r.yield_verdict, r.yield_note
    from sync_runs r
   order by r.started_at desc
   limit greatest(1, coalesce(p_limit, 20))
$$;