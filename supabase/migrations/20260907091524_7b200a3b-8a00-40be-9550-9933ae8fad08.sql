-- ---------------------------------------------------------------------------
-- 1. Owner-confirmed account ownership. No handover date: full history is SD.
-- ---------------------------------------------------------------------------
UPDATE public.ad_accounts SET agency_code = 'SD'
 WHERE account_id IN ('1249430309131428', '1488704194840585');

INSERT INTO public.rule_changes (rule_key, what_changed, old_rule, new_rule, reason, confirmed_by, affects, evidence) VALUES
('account_ownership.1488704194840585',
 'Ad account "Ritu Ad manager" (1488704194840585) is run by Sabhi Digital',
 'unassigned — no team',
 'agency_code = SD, for its full history (no handover date)',
 'Owner confirmed directly. This was the last account with 2026 spend carrying no team, so there is now zero unassigned spend: every rupee of 2026 ad spend sits under SD, SX or RJ.',
 'owner (Ritu Agarwal), 2026-09-07',
 ARRAY['agency spend basis','per-team ratios','lead team attribution'],
 jsonb_build_object('account_id','1488704194840585','spend_2026',634593,'last_spend','2026-07-24','unassigned_spend_after',0)),
('account_ownership.1249430309131428.history',
 'How far back the Sabhi Digital marking on "Ritu Agarwal 2" applies',
 'SD from the confirmation date onwards (handover date unknown)',
 'SD for its full history — SD has always run this account',
 'Owner confirmed there was never a handover: the account was Sabhi Digital from the start, so no date-split is needed and none should be invented.',
 'owner (Ritu Agarwal), 2026-09-07',
 ARRAY['agency spend basis','historic per-team figures'],
 jsonb_build_object('account_id','1249430309131428','handover_date',null));

-- ---------------------------------------------------------------------------
-- 2. Regime events: the app must never compare across one of these silently.
-- ---------------------------------------------------------------------------
CREATE TABLE public.regime_events (
  event_key      text PRIMARY KEY,
  agency_code    text,
  kind           text NOT NULL,
  boundary_date  date NOT NULL,
  label          text NOT NULL,
  plain          text NOT NULL,
  confirmed_by   text NOT NULL,
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.regime_events IS
  'Moments where WHO is buying changed. A window spanning boundary_date is comparing two different eras, so the app must say so on the face of the figure.';

GRANT SELECT ON public.regime_events TO anon, authenticated;
GRANT ALL ON public.regime_events TO service_role;
ALTER TABLE public.regime_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "regime events are readable" ON public.regime_events FOR SELECT USING (true);
CREATE POLICY "service role manages regime events" ON public.regime_events FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER update_regime_events_updated_at BEFORE UPDATE ON public.regime_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.regime_events (event_key, agency_code, kind, boundary_date, label, plain, confirmed_by, evidence) VALUES
('sx_wind_down', 'SX', 'agency_ceased', '2026-07-19',
 'SX stopped buying',
 'Roughly half of this year''s ad spend up to July was bought by SX, who stopped in July and run nothing now. August onwards is Sabhi Digital and Rajdeep only. A comparison that crosses 19 July is partly a change of who is buying — different accounts, different creative, different tracking quality — not only a change in how well the buying is working.',
 'owner (Ritu Agarwal), 2026-09-07',
 jsonb_build_object(
   'spend_2026', 10313794,
   'share_of_2026_spend_pct', 48.6,
   'accounts', jsonb_build_array(
     jsonb_build_object('account_id','1177480620566796','name','Ritu Agarwal-SX-2','last_spend','2026-07-08','spend_2026',7599770),
     jsonb_build_object('account_id','2929556933907035','name','Ritu-SX3','last_spend','2026-07-18','spend_2026',1203501),
     jsonb_build_object('account_id','1091860385814643','name','Ritu Agarwal-SX','last_spend','2026-06-02','spend_2026',1510522))));

INSERT INTO public.rule_changes (rule_key, what_changed, old_rule, new_rule, reason, confirmed_by, affects, evidence) VALUES
('regime.sx_wind_down',
 'Comparisons that cross 19 July 2026 now carry a visible notice',
 'month-over-month and period-over-period figures were drawn straight across July into August',
 'any window containing 19 July 2026 shows a regime notice on the face of the figure, the same way clipped coverage is shown today',
 'SX ran 48.6% of 2026 spend and stopped in July; Aug-Sep is SD and RJ only. Trends drawn across that date mix a change of team with a change of performance. The CPR reading of Rs 276 in July rising to Rs 466 now spans exactly this boundary.',
 'owner (Ritu Agarwal), 2026-09-07',
 ARRAY['month-over-month trends','CPR trend','baselines','goldens','28-day bands'],
 jsonb_build_object('boundary_date','2026-07-19'));

-- Window -> boundaries it crosses. Used by the render gate.
CREATE OR REPLACE FUNCTION public.regime_boundaries(p_start date, p_end date)
RETURNS TABLE(event_key text, agency_code text, boundary_date date, label text, plain text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT r.event_key, r.agency_code, r.boundary_date, r.label, r.plain
    FROM public.regime_events r
   WHERE r.enabled
     AND p_start IS NOT NULL AND p_end IS NOT NULL
     -- strictly inside: a window that starts or ends exactly on the boundary
     -- sits on one side of it and is not comparing across anything.
     AND r.boundary_date > p_start AND r.boundary_date <= p_end
   ORDER BY r.boundary_date;
$function$;
GRANT EXECUTE ON FUNCTION public.regime_boundaries(date, date) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Team populations just changed, so the ratios go back behind the gate.
-- ---------------------------------------------------------------------------
INSERT INTO public.agency_spend_status (agency_code, spend_synced, note, ratios_computable, ratio_note, ratios_hold, ratios_hold_reason)
VALUES ('SX', true, 'SX stopped buying in July 2026; spend is complete and closed', false,
        'SX no longer runs any ads — its figures are history, not a live rate', true,
        'held 2026-09-07: SX is a closed era and its ratios must not be compared with the current teams without the regime notice')
ON CONFLICT (agency_code) DO UPDATE
   SET spend_synced = true,
       ratios_hold = true,
       ratios_computable = false,
       ratios_hold_reason = excluded.ratios_hold_reason,
       updated_at = now();

UPDATE public.agency_spend_status
   SET ratios_hold = true,
       ratios_computable = false,
       ratios_hold_reason = 'held 2026-09-07: two accounts changed hands into SD and every lead is being re-derived from ad-account ownership. Released only when the symmetry gate passes on the new populations.',
       updated_at = now()
 WHERE agency_code IN ('SD','RJ');