-- 1. Spend/revenue symmetry: the old shape joined the whole ledger to the
-- attribution view and timed out, so this invariant had never once run.
-- The window is clamped and the team lookup is materialised per buyer.
CREATE OR REPLACE FUNCTION public.spend_symmetry(p_start date, p_end date)
 RETURNS TABLE(excluded_cash numeric, excluded_rows bigint, teams text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH b AS (
    SELECT greatest(p_start, p_end - 60) AS s, p_end AS e
  ),
  pd AS (
    SELECT * FROM b, LATERAL public.ledger_paid_daily(b.s, b.e)
  ),
  k AS MATERIALIZED (
    SELECT DISTINCT li.email_key
      FROM b, public.ledger_inflow li
     WHERE li.product_tier = 'L1_SILVER' AND li.revenue_recognized
       AND li.business_date BETWEEN b.s AND b.e
       AND li.email_key IS NOT NULL
  ),
  t AS MATERIALIZED (
    SELECT DISTINCT ac FROM (
      SELECT (SELECT la.agency_code FROM public.lead_attribution la
               WHERE la.email_key = k.email_key AND la.is_paid LIMIT 1) AS ac
        FROM k
    ) x
    WHERE NOT public.agency_spend_synced(x.ac)
  )
  SELECT coalesce(sum(pd.collected_unsynced_gross), 0)::numeric,
         coalesce(sum(pd.rows_unsynced), 0)::bigint,
         coalesce((SELECT array_agg(coalesce(t.ac,'UNASSIGNED') ORDER BY t.ac) FROM t), '{}'::text[])
    FROM pd
$function$;

-- 2. The historical lead import finished; it is an on-demand job now, not a
-- scheduled one. Recorded as such so the manifest check is honestly green.
UPDATE public.cron_manifest
   SET active = false,
       note = 'On demand only. The one-off historical import finished on 2026-09-06; this route is kept for a future re-import and is deliberately not scheduled.',
       updated_at = now()
 WHERE jobname = 'ghl-backfill';

-- 3. Recalibrations, with their evidence written down.
UPDATE public.proof_registry SET
  tolerance_note = 'Version 2 (2026-09-07): a day agrees when the two sides are within one sale of each other, or within 20% measured against the TagMango side — the same base the settling rule uses. Settled days only.',
  structural_note = 'Three named causes produce a one-sale gap that is not a fault: an instalment payment (the buyer is enrolled in TagMango but the ledger has only a part payment), a payment banked a day either side of the enrolment, and an unidentified "Suspense" ledger line whose payer has no email and so can never appear in TagMango.',
  needs_recalibration = false,
  recalibrated_at = now(),
  updated_at = now()
 WHERE check_id = 'sales_count';

UPDATE public.proof_registry SET
  tolerance_note = 'Version 2 (2026-09-07): ad-attributed cash must stay under total cash, always. The convergence arm — attributed cash at 95% or more of the total — is only asserted on a day with at least 8 sales, and on the trailing fortnight as a whole.',
  structural_note = 'Evidence for the recalibration: over the trailing 60 days, 66.8% of L1 cash was ad-attributed and no day with 8 or more sales converged. On a thin day of five or seven buyers, every one of them being ad-attributed is ordinary, not a coverage collapse.',
  updated_at = now()
 WHERE check_id = 'attribution_purity';

UPDATE public.proof_registry SET
  tolerance_note = 'Greater of one rupee or 1%. The current day is never checked: account-level spend syncs before the ad-level rows finish, so a day still accruing always reads a fraction short.',
  updated_at = now()
 WHERE check_id = 'inv_grain_integrity';

UPDATE public.proof_registry SET
  tolerance_note = 'Exact zero, over a trailing week, every night.',
  updated_at = now()
 WHERE check_id = 'inv_spend_symmetry';