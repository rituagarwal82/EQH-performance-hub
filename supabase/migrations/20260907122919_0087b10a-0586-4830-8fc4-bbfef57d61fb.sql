UPDATE public.golden_tests
   SET expected_value = 12487.01,
       note = 'Total Meta spend Rs 15,98,337.43 / 128 August L1 new sales whose buyer lead came from a Meta ad. Google reclassified as organic search 2026-09-07; six Meta-ad buyers previously stored with an organic platform label are now correctly counted.',
       verified_by = 'owner'
 WHERE golden_id = 'cost_per_sale_aug2026';

UPDATE public.metric_contracts SET is_current = false WHERE metric_id = 'cost_per_sale' AND is_current;

INSERT INTO public.metric_contracts (metric_id, version, owner_definition, unit, basis, grain, source_precedence, source_function, is_current, note)
SELECT 'cost_per_sale', COALESCE(max(version),0) + 1,
 'Total Meta spend in range, across all Meta ad accounts, divided by the count of L1 new sales whose buyer lead came from a Meta ad. No team-level exclusion is applied: if the spend is in the numerator, the sale it produced is in the denominator. Google/youtube traffic without a Google Ads click id is organic search, carries no media cost, and is excluded from both sides.',
 'inr', 'gross', 'day', 'spend: Meta; sales: ledger', 'paid_l1_new_sales_by_day', true,
 'v' || (COALESCE(max(version),0) + 1) || ' replaces the spend-synced-team predicate with a platform predicate.'
 FROM public.metric_contracts WHERE metric_id = 'cost_per_sale';

UPDATE public.review_items
   SET status = 'confirmed',
       resolved_note = 'Owner confirmed Google Ads is stopped. Zero of 3,974 google/youtube leads carry a click id; they are organic search and old campaign links. No spend to connect.',
       resolved_at = now(), updated_at = now()
 WHERE status = 'open' AND (title ILIKE '%Google%' OR detail ILIKE '%Google Ads spend%');