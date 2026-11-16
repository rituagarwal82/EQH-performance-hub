-- Re-version the two contracts whose sale definition moved to the ledger.
UPDATE public.metric_contracts SET is_current = false
 WHERE metric_id IN ('cost_per_sale','sales_per_1000_leads') AND is_current;

INSERT INTO public.metric_contracts
  (metric_id, version, owner_definition, unit, basis, grain, source_precedence, source_function, is_current, note)
SELECT 'cost_per_sale',
       COALESCE((SELECT max(version) FROM public.metric_contracts WHERE metric_id='cost_per_sale'),0)+1,
       'Measured Meta spend divided by paid-attributed L1 new sales from the accounts ledger, with the Book My Seat rule applied (a seat becomes a sale only at full payment).',
       'inr','ex_gst','day','ledger (sales) > meta (spend)','metric_components', true,
       'Moved off the TagMango enrolment count. Ledger is the sale source of truth.';

INSERT INTO public.metric_contracts
  (metric_id, version, owner_definition, unit, basis, grain, source_precedence, source_function, is_current, note)
SELECT 'sales_per_1000_leads',
       COALESCE((SELECT max(version) FROM public.metric_contracts WHERE metric_id='sales_per_1000_leads'),0)+1,
       'Paid-attributed L1 new sales from the accounts ledger divided by registrations on accounts with working lead tracking, times 1,000.',
       'count','gross','day','ledger (sales) > meta (registrations)','metric_components', true,
       'Moved off the TagMango enrolment count; denominator is measured accounts only.';

-- Verified checks over closed August 2026 for both metrics.
INSERT INTO public.golden_tests
  (golden_id, metric_id, contract_version, window_start, window_end, expected_value, tolerance_pct, verified_by, note)
SELECT 'cost_per_sale_aug2026','cost_per_sale',
       (SELECT version FROM public.metric_contracts WHERE metric_id='cost_per_sale' AND is_current),
       '2026-08-01','2026-08-31',
       (SELECT sum(measured_spend)/NULLIF(sum(paid_sales),0) FROM public.metric_components('2026-08-01','2026-08-31')),
       0.5,'owner audit 2026-09-07','Ledger sale definition, seat rule applied.'
WHERE NOT EXISTS (SELECT 1 FROM public.golden_tests WHERE golden_id='cost_per_sale_aug2026');

INSERT INTO public.golden_tests
  (golden_id, metric_id, contract_version, window_start, window_end, expected_value, tolerance_pct, verified_by, note)
SELECT 'sales_per_1000_leads_aug2026','sales_per_1000_leads',
       (SELECT version FROM public.metric_contracts WHERE metric_id='sales_per_1000_leads' AND is_current),
       '2026-08-01','2026-08-31',
       (SELECT sum(paid_sales)*1000.0/NULLIF(sum(registrations),0) FROM public.metric_components('2026-08-01','2026-08-31')),
       0.5,'owner audit 2026-09-07','Ledger sale definition over measured registrations.'
WHERE NOT EXISTS (SELECT 1 FROM public.golden_tests WHERE golden_id='sales_per_1000_leads_aug2026');