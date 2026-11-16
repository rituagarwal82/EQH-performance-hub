-- ═══ STEP 4 — WATCHDOG CALIBRATION DISCIPLINE ═══

create table if not exists public.proof_registry (
  check_id text primary key,
  family text not null check (family in ('proof','invariant','golden','contract')),
  label text not null,
  plain text not null,
  expected_noise text not null,
  fp_budget_per_30d numeric not null,
  tolerance_note text,
  structural_note text,
  enabled boolean not null default true,
  needs_recalibration boolean not null default false,
  recalibrated_at timestamptz,
  ord integer not null default 100,
  updated_at timestamptz not null default now()
);

grant select on public.proof_registry to authenticated;
grant all on public.proof_registry to service_role;
alter table public.proof_registry enable row level security;
drop policy if exists "registry readable" on public.proof_registry;
create policy "registry readable" on public.proof_registry for select to authenticated using (true);
drop policy if exists "registry writable by service role" on public.proof_registry;
create policy "registry writable by service role" on public.proof_registry
  for all to service_role using (true) with check (true);

insert into public.proof_registry
  (check_id, family, label, plain, expected_noise, fp_budget_per_30d, tolerance_note, structural_note, ord) values
  ('meta_spend','proof','Meta spend',
   'What we stored for each day against a fresh call to Meta''s own API for that day.',
   'Rare. Meta revises intraday figures, so a fully elapsed day should agree within 1%.', 2,
   '1% tolerance; the current day is never checked because it is still accruing.', null, 1),
  ('sales_count','proof','Sales count',
   'TagMango enrolments against the accounts ledger''s New Sale count, on settled days only.',
   'Occasional. Settled days should agree; a fire means a bookkeeping miss or a stalled feed.', 4,
   '20% tolerance on settled days only.', null, 2),
  ('registrations','proof','Registrations',
   'Registered leads in the CRM against registrants recorded by the webinar platform.',
   'At most one fire a month, from a webinar rescheduled across midnight.', 1,
   '60% tolerance. Zoom exposes per-session registrant counts only — no registrant emails — so the duplicate registrations cannot be removed and the tolerance carries them instead.',
   'Zoom counts a registrant once per session including the replay; the CRM counts a person once. The structural surplus has run 15-30%.', 3),
  ('attendance_integrity','proof','Attendance arithmetic',
   'Our own two ways of counting the same Zoom attendance, to catch aggregation bugs.',
   'Almost never. Both sides are ours, so any fire is our own bug.', 1,
   '2% tolerance.', null, 4),
  ('ledger_closed_months','proof','Closed months',
   'The agreed January-July sale counts, re-asserted against the ledger every day.',
   'Never. History must not move.', 0, 'Exact.', null, 5),
  ('attribution_purity','proof','Attribution purity',
   'Ad-attributed collections against total collections: the first can never exceed the second, and the two converging means attribution has stopped discriminating.',
   'Rare. Fires on a join bug or an attribution collapse.', 2,
   'Ad-attributed cash must stay under total cash and below 95% of it.', null, 6),
  ('inv_cron_manifest','invariant','Scheduled jobs match the manifest',
   'Every scheduled job is compared against the manifest: missing, unexpected, retimed, re-pointed, or no longer calling out over the network at all.',
   'Never outside a deploy. Any fire is real drift.', 0, 'Exact.',
   'The last arm is the tombstone of the http_post incident: a job whose command no longer calls net.http_post is a fault however healthy it looks.', 10),
  ('inv_cron_alive','invariant','Scheduled jobs are actually completing',
   'Each job must have completed successfully within twice its own interval — this catches a job that fires faithfully and is rejected every time.',
   'Rare. One fire after a deploy window is plausible.', 2, 'Twice the job''s own interval.', null, 11),
  ('inv_grain_integrity','invariant','Spend adds up at every level',
   'Account spend against the sum of its campaigns, campaigns against their ad sets, ad sets against their ads.',
   'Rare. Meta occasionally lags one grain behind another during a sync.', 3,
   'Greater of one rupee or 1%.', null, 12),
  ('inv_no_phantom_rows','invariant','No metric rows for unknown ads',
   'Not one spend row may belong to an ad, ad set or campaign that does not exist.',
   'Never. This is the tombstone of the 1.22-crore phantom-spend incident.', 0, 'Exact zero.', null, 13),
  ('inv_paid_within_total','invariant','Ad-attributed never exceeds the total',
   'Ad-attributed leads and ad-attributed cash must always sit inside the day''s totals.',
   'Never. A fire means the lead join is duplicating rows.', 0, 'Exact.', null, 14),
  ('inv_sales_within_enrolments','invariant','Sales never exceed enrolments',
   'A sale that nobody enrolled in cannot exist.',
   'Never.', 0, 'Exact.', null, 15),
  ('inv_ledger_vs_tagmango_silence','invariant','Ledger sold, TagMango silent',
   'A day with sales in the accounts ledger and no TagMango payments at all means the payments feed is not fetching, whatever it reports.',
   'Rare. Fires on a stuck cursor.', 2, 'Exact: any selling day with zero payment rows.',
   'This is the second lock on the stuck-cursor class, at the data level rather than the sync level.', 16),
  ('inv_coverage_monotonic','invariant','Coverage never goes backwards',
   'A feed whose data reaches less far today than it did before has lost rows or been re-pointed.',
   'Never.', 0, 'Exact.', null, 17),
  ('inv_rate_sanity','invariant','No impossible numbers in the data',
   'Attendance above 100%, negative spend, negative collections — caught in the data itself, not just refused by the screens.',
   'Never.', 0, 'Exact.', null, 18)
on conflict (check_id) do update set
  family = excluded.family, label = excluded.label, plain = excluded.plain,
  expected_noise = excluded.expected_noise, fp_budget_per_30d = excluded.fp_budget_per_30d,
  tolerance_note = excluded.tolerance_note, structural_note = excluded.structural_note,
  ord = excluded.ord, updated_at = now();

-- proof_summary now reads the registry, and a miscalibrated check stops shouting.
drop function if exists public.proof_summary();
create or replace function public.proof_summary()
returns table(check_id text, label text, plain text, family text, primary_source text, witness_source text,
              last_run timestamptz, hours_since numeric, days_checked integer, matches integer,
              tolerable integer, diverged integer, unavailable integer, worst_date date,
              worst_divergence numeric, worst_primary numeric, worst_witness numeric, worst_note text,
              status text, expected_noise text, fp_budget_per_30d numeric, tolerance_note text,
              structural_note text, needs_recalibration boolean, diverged_30d integer)
language sql stable security definer set search_path to 'public' as $function$
  WITH reg AS (SELECT * FROM public.proof_registry WHERE enabled),
  last AS (
    SELECT r.check_id, max(r.checked_at) AS last_run FROM public.reconciliations r GROUP BY r.check_id
  ),
  cur AS (
    SELECT r.* FROM public.reconciliations r JOIN last ON last.check_id = r.check_id
     WHERE r.checked_at > last.last_run - interval '2 hours'
  ),
  agg AS (
    SELECT c.check_id, count(*)::int AS days_checked,
           count(*) FILTER (WHERE c.verdict = 'match')::int AS matches,
           count(*) FILTER (WHERE c.verdict = 'tolerable')::int AS tolerable,
           count(*) FILTER (WHERE c.verdict = 'diverged')::int AS diverged,
           count(*) FILTER (WHERE c.verdict = 'witness_unavailable')::int AS unavailable,
           (array_agg(c.primary_source ORDER BY c.for_date DESC))[1] AS primary_source,
           (array_agg(c.witness_source ORDER BY c.for_date DESC))[1] AS witness_source
      FROM cur c GROUP BY c.check_id
  ),
  noise AS (
    SELECT r.check_id, count(DISTINCT r.for_date)::int AS diverged_30d
      FROM public.reconciliations r
     WHERE r.verdict = 'diverged' AND r.checked_at > now() - interval '30 days'
     GROUP BY r.check_id
  ),
  worst AS (
    SELECT DISTINCT ON (c.check_id)
           c.check_id, c.for_date, c.divergence_pct, c.primary_value, c.witness_value, c.note
      FROM cur c ORDER BY c.check_id, abs(coalesce(c.divergence_pct, 0)) DESC, c.for_date DESC
  )
  SELECT reg.check_id, reg.label, reg.plain, reg.family,
         agg.primary_source, agg.witness_source, last.last_run,
         CASE WHEN last.last_run IS NULL THEN NULL
              ELSE round(extract(epoch FROM (now() - last.last_run)) / 3600.0, 2) END,
         coalesce(agg.days_checked, 0), coalesce(agg.matches, 0), coalesce(agg.tolerable, 0),
         coalesce(agg.diverged, 0), coalesce(agg.unavailable, 0),
         worst.for_date, worst.divergence_pct, worst.primary_value, worst.witness_value, worst.note,
         CASE
           WHEN last.last_run IS NULL THEN 'never_run'
           WHEN extract(epoch FROM (now() - last.last_run)) / 3600.0 > 48 THEN 'stale'
           WHEN reg.needs_recalibration THEN 'recalibrating'
           WHEN coalesce(agg.diverged, 0) > 0 THEN 'diverged'
           WHEN coalesce(agg.matches, 0) + coalesce(agg.tolerable, 0) = 0 THEN 'unverified'
           ELSE 'match'
         END,
         reg.expected_noise, reg.fp_budget_per_30d, reg.tolerance_note, reg.structural_note,
         reg.needs_recalibration, coalesce(noise.diverged_30d, 0)
    FROM reg
    LEFT JOIN last ON last.check_id = reg.check_id
    LEFT JOIN agg  ON agg.check_id  = reg.check_id
    LEFT JOIN noise ON noise.check_id = reg.check_id
    LEFT JOIN worst ON worst.check_id = reg.check_id
   ORDER BY reg.ord
$function$;

-- 30-cell history strip, one cell per day per check.
create or replace function public.proof_history_strip(p_days integer default 30)
returns table(check_id text, for_date date, verdict text)
language sql stable security definer set search_path to 'public' as $$
  select r.check_id, r.for_date, r.verdict
    from public.reconciliations r
   where r.for_date > current_date - greatest(1, coalesce(p_days, 30))
   order by r.check_id, r.for_date
$$;

-- Budget enforcement: a check over its false-alarm budget stops shouting.
create or replace function public.enforce_watchdog_budgets()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare out_rows jsonb := '[]'::jsonb; r record;
begin
  for r in
    select g.check_id, g.label, g.fp_budget_per_30d, g.expected_noise,
           (select count(distinct x.for_date) from reconciliations x
             where x.check_id = g.check_id and x.verdict = 'diverged'
               and x.checked_at > now() - interval '30 days')::int as fires
      from proof_registry g where g.enabled
  loop
    if r.fires > r.fp_budget_per_30d then
      if not exists (select 1 from proof_registry p where p.check_id = r.check_id and p.needs_recalibration) then
        update proof_registry set needs_recalibration = true, updated_at = now()
         where check_id = r.check_id;
      end if;
      out_rows := out_rows || jsonb_build_array(jsonb_build_object(
        'check_id', r.check_id, 'label', r.label,
        'fires', r.fires, 'budget', r.fp_budget_per_30d, 'expected_noise', r.expected_noise));
    end if;
  end loop;
  return out_rows;
end $$;

-- Resolving the review item returns the check to service.
create or replace function public.watchdog_recalibration_resolved()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.kind = 'watchdog_recalibration' and new.status <> 'open' and old.status = 'open' then
    update proof_registry
       set needs_recalibration = false, recalibrated_at = now(), updated_at = now()
     where check_id = new.ref_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_watchdog_recalibration_resolved on public.review_items;
create trigger trg_watchdog_recalibration_resolved
  after update of status on public.review_items
  for each row execute function public.watchdog_recalibration_resolved();

-- ═══ GOLDEN ANCHORS (seeded now; the harness that runs them lands in wave 2) ═══

create table if not exists public.golden_tests (
  golden_id text primary key,
  metric_id text not null,
  contract_version integer not null default 1,
  window_start date not null,
  window_end date not null,
  expected_value numeric not null,
  tolerance_abs numeric,
  tolerance_pct numeric,
  verified_by text not null,
  note text,
  created_at timestamptz not null default now(),
  check ((tolerance_abs is null) <> (tolerance_pct is null))
);

-- A golden may only anchor a CLOSED window — never a period still moving.
create or replace function public.golden_window_closed()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  if new.window_end >= current_date then
    raise exception 'A golden test must anchor a closed window; % has not finished', new.window_end;
  end if;
  return new;
end $$;

drop trigger if exists trg_golden_window_closed on public.golden_tests;
create trigger trg_golden_window_closed
  before insert or update on public.golden_tests
  for each row execute function public.golden_window_closed();

create table if not exists public.golden_runs (
  id uuid primary key default gen_random_uuid(),
  golden_id text not null references public.golden_tests(golden_id) on delete cascade,
  run_at timestamptz not null default now(),
  trigger_kind text not null check (trigger_kind in ('nightly','deploy','manual')),
  deploy_ref text,
  computed_value numeric,
  delta numeric,
  pass boolean,
  error text
);

grant select on public.golden_tests to authenticated;
grant select on public.golden_runs to authenticated;
grant all on public.golden_tests to service_role;
grant all on public.golden_runs to service_role;
alter table public.golden_tests enable row level security;
alter table public.golden_runs enable row level security;
drop policy if exists "goldens readable" on public.golden_tests;
create policy "goldens readable" on public.golden_tests for select to authenticated using (true);
drop policy if exists "goldens writable by service role" on public.golden_tests;
create policy "goldens writable by service role" on public.golden_tests for all to service_role using (true) with check (true);
drop policy if exists "golden runs readable" on public.golden_runs;
create policy "golden runs readable" on public.golden_runs for select to authenticated using (true);
drop policy if exists "golden runs writable by service role" on public.golden_runs;
create policy "golden runs writable by service role" on public.golden_runs for all to service_role using (true) with check (true);

insert into public.golden_tests
  (golden_id, metric_id, window_start, window_end, expected_value, tolerance_abs, tolerance_pct, verified_by, note) values
  ('meta_spend_2026_jan_aug','meta_spend','2026-01-01','2026-08-31', 19952229, 1, null, 'owner',
   'Total Meta spend for the first eight months of 2026, agreed to the rupee.'),
  ('ledger_l1_new_sales_2026_08','ledger_l1_new_sales','2026-08-01','2026-08-31', 152, 0, null, 'owner',
   'New L1 sales tagged in the accounts ledger for August 2026.')
on conflict (golden_id) do update set
  expected_value = excluded.expected_value, tolerance_abs = excluded.tolerance_abs,
  tolerance_pct = excluded.tolerance_pct, note = excluded.note;

/** Computes one golden and records the run. Never mutates the metric itself. */
create or replace function public.run_golden(p_golden_id text, p_trigger text default 'manual', p_deploy_ref text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare g record; v numeric; v_pass boolean; v_delta numeric; v_err text;
begin
  select * into g from golden_tests where golden_id = p_golden_id;
  if not found then return jsonb_build_object('error','no such golden'); end if;

  begin
    if g.metric_id = 'meta_spend' then
      select coalesce(sum(spend),0) into v from daily_metrics
       where level = 'account' and date between g.window_start and g.window_end;
    elsif g.metric_id = 'ledger_l1_new_sales' then
      select count(*)::numeric into v from ledger_inflow
       where is_new_sale and business_date between g.window_start and g.window_end;
    else
      v_err := 'No computation is defined for ' || g.metric_id;
    end if;
  exception when others then v_err := sqlerrm;
  end;

  if v_err is null then
    v_delta := v - g.expected_value;
    v_pass := case when g.tolerance_abs is not null then abs(v_delta) <= g.tolerance_abs
                   else abs(v_delta) <= abs(g.expected_value) * g.tolerance_pct / 100.0 end;
  end if;

  insert into golden_runs (golden_id, trigger_kind, deploy_ref, computed_value, delta, pass, error)
  values (p_golden_id, p_trigger, p_deploy_ref, v, v_delta, v_pass, v_err);

  return jsonb_build_object('golden_id', p_golden_id, 'expected', g.expected_value,
    'computed', v, 'delta', v_delta, 'pass', v_pass, 'error', v_err);
end $$;