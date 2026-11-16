-- 1. Cost per sale: platform predicate, not team-spend-synced predicate.
CREATE OR REPLACE FUNCTION public.paid_l1_new_sales_by_day(p_start date, p_end date)
 RETURNS TABLE(business_date date, paid_sales bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT l.business_date,
         count(*) FILTER (
           WHERE l.counts_as_sale AND EXISTS (
             SELECT 1
               FROM public.buyer_lead_link k
               JOIN public.lead_attribution_mv la ON la.email_key = k.lead_email_key
              WHERE k.email_key = l.email_key
                AND la.is_paid
                AND lower(la.platform) IN ('meta','facebook')
           )
         )::bigint
    FROM public.ledger_inflow l
   WHERE l.product_tier = 'L1_SILVER' AND l.business_date BETWEEN p_start AND p_end
   GROUP BY l.business_date;
$function$;

-- 2. Contract v5 for cost_per_sale.
UPDATE public.metric_contracts SET is_current = false WHERE metric_id = 'cost_per_sale';
INSERT INTO public.metric_contracts (metric_id, version, owner_definition, unit, basis, grain, source_precedence, source_function, is_current, note)
SELECT 'cost_per_sale', 5,
  'Total Meta account-level spend for the window divided by Meta-attributed L1 new sales from the accounts ledger. A sale counts when the buyer joins a lead (by email or phone) whose traffic platform is Meta/Facebook, which is exactly the traffic the spend paid for. Team-spend-synced status is no longer used as the filter: it dropped Meta sales whose lead carried no team tag. Google and organic sales are excluded because no Google spend is in the numerator. The Book My Seat rule applies: a seat becomes a sale only at full payment.',
  c.unit, c.basis, c.grain, c.source_precedence, c.source_function, true,
  'v5 2026-09-07: exclusion lever changed from agency_spend_synced to platform.'
  FROM public.metric_contracts c WHERE c.metric_id = 'cost_per_sale' AND c.version = 4;

UPDATE public.golden_tests
   SET expected_value = 13101.13, contract_version = 5,
       note = 'Re-derived 2026-09-07 after the Meta-platform exclusion fix: 1598337.43 spend / 122 Meta-attributed sales.'
 WHERE golden_id = 'cost_per_sale_aug2026';

-- 3. Offer timing: measure against the fixed script moment.
CREATE OR REPLACE FUNCTION public.offer_timing_consistency(_from date, _to date)
 RETURNS TABLE(business_date date, session_uuid text, script_offer_minute numeric, observed_offer_minute numeric, deviation_minutes numeric, note text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH script AS (
    SELECT round(min(m.at_webinar_ms) / 60000.0, 1) AS offer_minute
      FROM public.script_markers m
     WHERE m.is_offer_moment AND m.at_webinar_ms IS NOT NULL
  )
  SELECT s.business_date,
         s.session_uuid,
         script.offer_minute,
         round(script.offer_minute
               + extract(epoch FROM (s.start_time - public.session_t0(s.start_time))) / 60.0, 1),
         round(extract(epoch FROM (s.start_time - public.session_t0(s.start_time))) / 60.0, 1),
         'Simulive: the offer moment is fixed in the recording, so the only way it moves is the session starting off the promised time.'
    FROM public.zoom_sessions s CROSS JOIN script
   WHERE s.session_role IN ('live','replay')
     AND s.business_date BETWEEN _from AND _to
   ORDER BY s.business_date DESC
$function$;

-- 4. Canonical transcript coverage: same script has been in rotation all along.
UPDATE public.webinar_transcripts
   SET effective_from = '2026-03-01',
       note = coalesce(note || ' | ', '') || 'Backdated 2026-09-07 to 2026-03-01: the webinars are simulive and this script has been the one in rotation. Assumed start of rotation — confirm the true date.'
 WHERE is_canonical AND coverage = 'full';

-- 5. Simulive is the default for new sessions.
ALTER TABLE public.zoom_sessions ALTER COLUMN session_format SET DEFAULT 'simulive';
UPDATE public.zoom_sessions SET session_format = 'simulive'
 WHERE session_format IS NULL AND session_role IN ('live','replay');

-- 6. Drop the superseded start-time helper.
DROP FUNCTION IF EXISTS public.session_t0_old(timestamptz);

-- 7. sync_health: a clean run with nothing new is a success, not a failure.
CREATE OR REPLACE VIEW public.sync_health
WITH (security_invoker = true) AS
 WITH last_ok AS (
         SELECT sync_runs.source, max(COALESCE(sync_runs.finished_at, sync_runs.started_at)) AS at
           FROM sync_runs
          WHERE sync_runs.status = ANY (ARRAY['success'::text, 'ok'::text, 'partial'::text, 'warning'::text, 'success_no_yield'::text])
          GROUP BY sync_runs.source
        ), last_any AS (
         SELECT sync_runs.source, max(sync_runs.started_at) AS at FROM sync_runs GROUP BY sync_runs.source
        ), fails AS (
         SELECT r.source, count(*) AS n
           FROM sync_runs r LEFT JOIN last_ok o_1 ON o_1.source = r.source
          WHERE r.status = 'error' AND (o_1.at IS NULL OR r.started_at > o_1.at)
          GROUP BY r.source
        )
 SELECT c.source, c.label, c.cadence_hours, c.is_critical, c.note,
    o.at AS last_success, a.at AS last_run,
    CASE WHEN o.at IS NULL THEN NULL::numeric ELSE round(EXTRACT(epoch FROM now() - o.at) / 3600.0, 1) END AS hours_since_success,
    COALESCE(f.n, 0::bigint)::integer AS consecutive_failures,
    ( SELECT r.error FROM sync_runs r WHERE r.source = c.source AND r.error IS NOT NULL ORDER BY r.started_at DESC LIMIT 1) AS last_error,
    CASE WHEN o.at IS NULL THEN 'dead'::text
         WHEN (EXTRACT(epoch FROM now() - o.at) / 3600.0) >= (c.cadence_hours * 3::numeric) THEN 'dead'::text
         WHEN (EXTRACT(epoch FROM now() - o.at) / 3600.0) >= (c.cadence_hours * 1.5) THEN 'late'::text
         ELSE 'ok'::text END AS status
   FROM sync_source_config c
     LEFT JOIN last_ok o ON o.source = c.source
     LEFT JOIN last_any a ON a.source = c.source
     LEFT JOIN fails f ON f.source = c.source;

-- 8. Record both rule changes.
INSERT INTO public.rule_changes (rule_key, what_changed, old_rule, new_rule, reason, confirmed_by, affects, evidence)
VALUES
 ('webinar_clock_anchor',
  'Webinar time-watched and retention are measured from the promised start time, not the room-open time.',
  'Slots 10:45,14:45,18:45,19:45 IST; attendance measured from the stored session start.',
  'Slots 15:00,19:00 IST (effective-dated history); attendance measured from the promised start.',
  'Owner confirmed the advertised times are 3 PM and 7 PM IST; rooms open 15-25 minutes early with promo video, which was being counted as webinar time.',
  'owner', ARRAY['retention_60','retention_30','retention_90','show_up_rate','avg_minutes'],
  '{"last_30d_avg_minutes":{"before":64.8,"after":61.5},"at_60":{"before":2393,"after":2336}}'::jsonb),
 ('cost_per_sale_exclusion',
  'A sale counts towards cost per sale when its lead came from a Meta ad, not when its team has spend connected.',
  'Attributed sale required agency_spend_synced(agency_code).',
  'Attributed sale requires the lead platform to be Meta/Facebook.',
  'Team tags and Meta traffic only coincide today; a Meta sale with no team tag was silently dropped and inflated the figure.',
  'owner', ARRAY['cost_per_sale','sales_per_1000_leads'],
  '{"august":{"old_sales":125,"new_sales":122,"old_value":12786.70,"new_value":13101.13}}'::jsonb);

-- 9. Owner item: Google is selling with no spend recorded.
INSERT INTO public.review_items (kind, ref_id, title, detail, evidence, status)
VALUES ('question', 'google_spend_gap',
 'Can Google Ads spend be connected?',
 'Google is not dormant: 443 Google leads in August 2026 and 15 August sales trace to Google traffic, but no Google spend exists anywhere in the system. Those sales are excluded from cost per sale because there is no cost to divide by. Connecting Google spend would close a real measurement gap.',
 '{"august_google_leads":443,"august_google_sales":15,"google_spend":null}'::jsonb,
 'open');