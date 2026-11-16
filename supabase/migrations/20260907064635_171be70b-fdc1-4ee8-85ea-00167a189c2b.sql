INSERT INTO public.proof_registry
  (check_id, family, label, plain, expected_noise, fp_budget_per_30d, tolerance_note, structural_note, enabled, needs_recalibration, ord, updated_at)
VALUES (
  'attribution_purity_window', 'proof', 'Attribution over the fortnight',
  'Across the whole period, ad-attributed L1 cash should be a clear minority-to-majority share of all L1 cash — never almost all of it. This is the arm that catches an attribution collapse, because a single thin day cannot.',
  'Rare. Fires when attribution starts claiming organic buyers.',
  1,
  'Diverges when the window-wide share reaches 95%.',
  'The trailing 60 days run at 66.8% ad-attributed. A window at 95% or above means organic buyers have stopped being recognised as organic.',
  true, false,
  (SELECT coalesce(max(ord),0) + 1 FROM public.proof_registry WHERE family = 'proof'),
  now())
ON CONFLICT (check_id) DO NOTHING;