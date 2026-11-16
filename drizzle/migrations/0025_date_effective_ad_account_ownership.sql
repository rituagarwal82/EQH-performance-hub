-- Date-effective ad-account ownership. History never moves: a period is a row,
-- never an edit to ad_accounts.agency_code.

CREATE TABLE IF NOT EXISTS public.ad_account_ownership (
  account_id text NOT NULL REFERENCES public.ad_accounts(account_id) ON DELETE CASCADE,
  agency_code text NOT NULL,
  valid_from date NOT NULL DEFAULT DATE '2000-01-01',
  valid_to date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, valid_from)
);

GRANT SELECT ON public.ad_account_ownership TO authenticated;
GRANT ALL ON public.ad_account_ownership TO service_role;
ALTER TABLE public.ad_account_ownership ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read ad_account_ownership" ON public.ad_account_ownership;
CREATE POLICY "read ad_account_ownership" ON public.ad_account_ownership
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "service role manages ad_account_ownership" ON public.ad_account_ownership;
CREATE POLICY "service role manages ad_account_ownership" ON public.ad_account_ownership
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Seed: each ScaleX account owned by SX up to and including its last ScaleX spend day.
INSERT INTO public.ad_account_ownership (account_id, agency_code, valid_from, valid_to, note)
SELECT d.account_id, 'SX', DATE '2000-01-01', max(d.date),
       'ScaleX period, closed at its last spend day (owner-verified 15 Sep 2026)'
  FROM public.daily_metrics d
 WHERE d.level = 'account' AND d.spend > 0
   AND d.account_id IN ('1091860385814643','1177480620566796','2929556933907035')
 GROUP BY d.account_id
ON CONFLICT (account_id, valid_from) DO NOTHING;

-- Who owned an account on a given day. Accounts with no ownership rows keep the
-- single code on ad_accounts, so nothing else in the system changes.
CREATE OR REPLACE FUNCTION public.account_agency_at(p_account_id text, p_date date)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.ad_account_ownership o WHERE o.account_id = p_account_id)
      THEN (SELECT o.agency_code FROM public.ad_account_ownership o
             WHERE o.account_id = p_account_id
               AND p_date >= o.valid_from
               AND (o.valid_to IS NULL OR p_date <= o.valid_to)
             ORDER BY o.valid_from DESC LIMIT 1)
    ELSE (SELECT a.agency_code FROM public.ad_accounts a WHERE a.account_id = p_account_id)
  END
$$;

REVOKE ALL ON FUNCTION public.account_agency_at(text, date) FROM public;
GRANT EXECUTE ON FUNCTION public.account_agency_at(text, date) TO authenticated, service_role;

-- Monthly spend by owning team: PRM_ campaign spend is Parami's from its first
-- rupee; the rest of an account's day belongs to whoever owned it that day.
CREATE OR REPLACE FUNCTION public.spend_agency_month()
RETURNS TABLE(month text, agency_code text, spend numeric, retarget numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH prm AS (
    SELECT d.date, d.account_id, sum(d.spend) AS spend
      FROM public.daily_metrics d
      JOIN public.ad_entities e ON e.entity_id = d.entity_id
     WHERE d.level = 'campaign' AND e.name ILIKE 'PRM\_%'
     GROUP BY 1,2
  ), acct AS (
    SELECT d.date, d.account_id, d.spend, coalesce(p.spend, 0) AS prm_spend
      FROM public.daily_metrics d
      LEFT JOIN prm p ON p.date = d.date AND p.account_id = d.account_id
     WHERE d.level = 'account'
  ), split AS (
    SELECT date, account_id, least(prm_spend, spend) AS spend, 'PRM'::text AS code
      FROM acct WHERE prm_spend > 0
    UNION ALL
    SELECT date, account_id, greatest(spend - prm_spend, 0),
           public.account_agency_at(account_id, date)
      FROM acct
  )
  SELECT to_char(s.date,'YYYY-MM'), s.code,
         sum(s.spend)::numeric,
         coalesce(sum(s.spend) FILTER (WHERE a.account_role = 'retargeting_brand'), 0)::numeric
    FROM split s
    JOIN public.ad_accounts a ON a.account_id = s.account_id
   WHERE s.code IS NOT NULL AND s.spend <> 0
   GROUP BY 1,2
$$;

REVOKE ALL ON FUNCTION public.spend_agency_month() FROM public;
GRANT EXECUTE ON FUNCTION public.spend_agency_month() TO authenticated, service_role;

-- Handover watch: tag Parami entities, alert on first Parami spend, and ask the
-- owner about any non-Parami spend in a closed account.
CREATE OR REPLACE FUNCTION public.check_ad_account_handover()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_first date; v_unknown int := 0; v_alert int := 0; r record;
BEGIN
  UPDATE public.ad_entities e SET agency_code = 'PRM'
   WHERE e.agency_code IS DISTINCT FROM 'PRM'
     AND (
       (e.level = 'campaign' AND e.name ILIKE 'PRM\_%')
       OR EXISTS (SELECT 1 FROM public.ad_entities c
                   WHERE c.entity_id = e.parent_id AND c.name ILIKE 'PRM\_%')
       OR EXISTS (SELECT 1 FROM public.ad_entities s
                    JOIN public.ad_entities c ON c.entity_id = s.parent_id
                   WHERE s.entity_id = e.parent_id AND c.name ILIKE 'PRM\_%')
     );

  SELECT min(d.date) INTO v_first
    FROM public.daily_metrics d
    JOIN public.ad_entities e ON e.entity_id = d.entity_id
   WHERE d.level = 'campaign' AND e.name ILIKE 'PRM\_%' AND d.spend > 0;

  IF v_first IS NOT NULL THEN
    INSERT INTO public.review_items (kind, ref_id, title, detail, evidence, status)
    SELECT 'owner_action', 'parami_first_spend',
           'Parami''s first ad spend has arrived — check its first leads',
           'The first spend in a PRM_ campaign was on ' || to_char(v_first,'DD Mon YYYY') ||
           '. Worth checking that leads from it are arriving and showing as Parami.',
           jsonb_build_object('first_spend_date', v_first), 'open'
     WHERE NOT EXISTS (SELECT 1 FROM public.review_items WHERE ref_id = 'parami_first_spend');
    v_alert := 1;
  END IF;

  FOR r IN
    SELECT d.account_id, a.name AS acct_name, min(d.date) AS from_d,
           round(sum(d.spend)) AS spend, string_agg(DISTINCT e.name, ', ') AS camps
      FROM public.daily_metrics d
      JOIN public.ad_entities e ON e.entity_id = d.entity_id
      JOIN public.ad_accounts a ON a.account_id = d.account_id
     WHERE d.level = 'campaign' AND d.spend > 0 AND d.date > DATE '2026-09-15'
       AND e.name NOT ILIKE 'PRM\_%'
       AND EXISTS (SELECT 1 FROM public.ad_account_ownership o
                    WHERE o.account_id = d.account_id AND o.valid_to IS NOT NULL)
       AND public.account_agency_at(d.account_id, d.date) IS NULL
     GROUP BY 1,2
  LOOP
    INSERT INTO public.review_items (kind, ref_id, title, detail, evidence, status)
    SELECT 'owner_action', 'handover_unknown_' || r.account_id,
           'New spend in an old ScaleX account under a non-Parami campaign name — whose is it?',
           'The account "' || r.acct_name || '" started spending again on ' ||
           to_char(r.from_d,'DD Mon YYYY') || ' (about ' || r.spend ||
           ' so far) under campaigns not named PRM_: ' || r.camps ||
           '. Tell me which team this belongs to so the spend lands in the right place.',
           jsonb_build_object('account_id', r.account_id, 'from_date', r.from_d,
                              'spend', r.spend, 'campaigns', r.camps), 'open'
     WHERE NOT EXISTS (SELECT 1 FROM public.review_items
                        WHERE ref_id = 'handover_unknown_' || r.account_id AND status = 'open');
    v_unknown := v_unknown + 1;
  END LOOP;

  RETURN jsonb_build_object('parami_alert', v_alert, 'unknown_spend_accounts', v_unknown);
END $$;

REVOKE ALL ON FUNCTION public.check_ad_account_handover() FROM public;
GRANT EXECUTE ON FUNCTION public.check_ad_account_handover() TO service_role;