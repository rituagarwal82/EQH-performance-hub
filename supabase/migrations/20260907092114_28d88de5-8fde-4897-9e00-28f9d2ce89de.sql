
-- 1. Annotation columns (no figure is changed)
ALTER TABLE public.metric_baselines
  ADD COLUMN IF NOT EXISTS spans_regime boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS regime_note text;
ALTER TABLE public.golden_tests
  ADD COLUMN IF NOT EXISTS spans_regime boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS regime_note text;

UPDATE public.golden_tests g
   SET spans_regime = true,
       regime_note = 'Built across the SX wind-down (' || r.boundary_date || '). Part of any change against this figure is a change of team, not of performance.'
  FROM public.regime_events r
 WHERE r.enabled
   AND r.boundary_date > g.window_start
   AND r.boundary_date <= g.window_end;

UPDATE public.metric_baselines b
   SET spans_regime = true,
       regime_note = 'Observation window crosses the SX wind-down (2026-07-19); roughly half of pre-boundary spend was run by a team that no longer buys.'
 WHERE EXISTS (
   SELECT 1 FROM public.regime_events r
    WHERE r.enabled
      AND r.boundary_date <= b.computed_at::date
      AND r.boundary_date > (
        b.computed_at::date - (b.n_observations * CASE b.grain
          WHEN 'day' THEN interval '1 day'
          WHEN 'week' THEN interval '7 days'
          WHEN 'month' THEN interval '1 month'
          ELSE interval '1 day' END))::date
 );

-- 2. The check the old level test could not make: account spend with NO witness beneath it
CREATE OR REPLACE FUNCTION public.inv_unwitnessed_spend_rows(p_start date, p_end date)
RETURNS TABLE (
  check_id text, checked_at timestamptz, for_date date,
  primary_value numeric, primary_source text,
  witness_value numeric, witness_source text,
  divergence_pct numeric, verdict text, note text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH d AS (
    SELECT m.date,
           m.account_id,
           coalesce(sum(m.spend) FILTER (WHERE m.level = 'account'), 0) AS acct,
           coalesce(sum(m.spend) FILTER (WHERE m.level = 'campaign'), 0) AS camp
      FROM public.daily_metrics m
     WHERE m.date BETWEEN p_start AND p_end
     GROUP BY m.date, m.account_id
  ), agg AS (
    SELECT date,
           sum(acct) AS acct_total,
           sum(acct) FILTER (WHERE camp = 0 AND acct > 0) AS unwitnessed,
           count(*) FILTER (WHERE camp = 0 AND acct > 0) AS n_accounts
      FROM d GROUP BY date
  )
  SELECT 'inv_unwitnessed_spend',
         now(),
         date,
         round(coalesce(unwitnessed, 0), 2),
         'Account spend with no campaign, ad set or ad detail behind it',
         round(acct_total, 2),
         'All account spend for the day',
         CASE WHEN acct_total = 0 THEN 0 ELSE round(100 * coalesce(unwitnessed, 0) / acct_total, 2) END,
         CASE WHEN coalesce(unwitnessed, 0) = 0 THEN 'match' ELSE 'diverged' END,
         CASE WHEN coalesce(unwitnessed, 0) = 0
              THEN 'Every rupee of spend has detail beneath it that can be checked.'
              ELSE n_accounts || ' account(s) reported spend with nothing beneath it — those rupees cannot be checked against Meta at any level.'
         END
    FROM agg
   WHERE acct_total > 0
   ORDER BY date
$$;

GRANT EXECUTE ON FUNCTION public.inv_unwitnessed_spend_rows(date, date) TO authenticated, service_role;

INSERT INTO public.proof_registry (check_id, family, label, plain, expected_noise, fp_budget_per_30d, structural_note, enabled, ord)
VALUES (
  'inv_unwitnessed_spend', 'invariant',
  'Spend with nothing beneath it',
  'Money reported at account level that has no campaign, ad set or ad detail behind it, so it can never be checked.',
  'Zero once every buying account is synced at ad level.',
  0,
  'The level-consistency check only compares accounts that already have detail, so an account with no detail at all was invisible to it.',
  true,
  (SELECT coalesce(max(ord), 0) + 1 FROM public.proof_registry)
)
ON CONFLICT (check_id) DO UPDATE
  SET enabled = true, structural_note = excluded.structural_note, updated_at = now();

-- 3. Record the finding
INSERT INTO public.rule_changes (rule_key, what_changed, old_rule, new_rule, reason, confirmed_by, affects, evidence)
VALUES (
  'proof.unwitnessed_spend',
  'Added a check for spend with no detail beneath it, and marked every band and verified figure built across the SX wind-down.',
  'Level consistency only compared accounts that already had campaign detail, so accounts with none were skipped as "match".',
  'Any account reporting spend with zero campaign detail is now reported as diverged, with the rupees named.',
  'The SX era (Jan to 18 July) has account totals only and no detail at any level, so 48.6% of 2026 spend was never checkable.',
  'owner',
  ARRAY['meta_spend','front_end_roas','cost_per_sale','metric_baselines','golden_tests'],
  jsonb_build_object(
    'sx_account_only_spend', 10313795,
    'sx_campaign_level_spend', 0,
    'sd_ad_level_before_july', 0,
    'boundary_date', '2026-07-19'
  )
);
