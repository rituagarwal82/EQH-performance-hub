# EQH Performance Engine — roadmap

## UX restructure (owner-approved, wave order)
- [x] Wave 0 — FilterScope wiring, agency-scoped ratio gate, agency selector out of global RangeBar, CPR contract reconciled
- [x] Wave 1 — global density switch, one Kpi component, top-bar diet (3 presets + ⋯, one worst-feed chip, Data menu), last7 default, mobile sweep started
- [x] Wave 2 — Today (/) Layer-1 cut: 4 tiles + verdict, disclosures for Checks / Morning brief / Cash & ceiling / Scaling, accounts top-5, Google dormant card removed
- [x] Wave 3 — /sales inversion (headline line, counting-rules disclosure, Attribution & teams section, rails Working-only, monthly spend column, tier row → drawer)
- [x] Wave 4 — /show-up (show-up rate + 60-min retention KPIs, RangeBar last30, retention drawer, SourcePanel/events Working-only, topic admin → /settings)
- [x] Wave 5 + 5b — /ads, /pages, /creative, /trust, /settings, one table skin, NO_DATA constant, Figure footers, delete MonthlySpendChart
- [x] Wave 6 — /weekly Weekly Review (composed from existing gated figures only, week picker, sidebar link, printable, outage-honest)

## Acceptance (applies to every wave, before "done")
- [x] Full permutation sweep run 2026-09-07: 16 routes × Brief/Working × desktop + 390px (48 cells) and 12 routes × 6 range/agency URLs (96 cells). Failures found and fixed: (1) long database-error text broke the page width on Today at 390px — outage text now wraps; (2) Settings traffic-source table rendered in unstable row order, causing a hydration mismatch — rows now sorted by source; (3) Data Trust hand-rolled tables had no n/window footers — added. Zero JavaScript errors across all cells. Caveat: the money screens (/, /ads, parts of /weekly) were in the honest "engine cannot read its data" state during the sweep because the shared overview query times out in the database — visual judgement of those populated states is still owed once the database load issue is addressed.

## Wave 7 — The Advisor (runs after the UX waves)
- [ ] A. strategy_rulebook table (versioned, editable in /settings) + seed: kill_ad, kill_adset, scale_winner, clone_winner, portfolio_balance, concept_gap, budget_band — all thresholds as params
- [ ] B. Advisor engine (Mondays after analyst + on-demand): contract-gated inputs only, emits recommendations rows with evidence + confidence; "not enough data to advise" is a first-class output; Google dormant line
- [ ] C. /advisor page: L1 sentence, KILL/SCALE/CLONE/SCRIPT NEXT/REBALANCE cards with evidence + provenance + Accept/Reject, per-agency tabs (SD/RJ), shared-account honesty
- [ ] D. WhatsApp brief export per agency (plain text, Indian number format)
- [ ] E. AI narrative via Gemini with the same number-validation harness — narrates, never invents
- [ ] F. recommendation_outcomes: 14/28-day snapshots, honest track-record scoreboard
- [ ] G. Targeting scope honesty: ad-set / creative / persona level only — never audience composition
- [ ] Dry run against last week's data; report the recommendations it would have made for owner audit before the page ships

### Wave 7 amendment — solution-grade output (format/depth only; engine, rulebook, gating, self-scoring unchanged)
- [ ] SCRIPT_NEXT ships a DRAFT DELIVERABLE: AI-written ad script (2-3 hook options, body in the proven structure for that concept, CTA) from the creative taxonomy, top scripts' registered text as style reference, persona language; watermarked "DRAFT — owner approval required before any agency use"; stored in creative_scripts with status='draft_ai'; approved drafts flow into the registry + ad-name pipeline
- [ ] KILL/SCALE/CLONE cards carry an IMPLEMENTATION block — exact platform steps a junior media buyer can execute verbatim (e.g. "Pause ad X in ad set Y. Do not delete." / "Raise ad set Z daily budget ₹4,000→₹5,200. No other edits same day.")
- [ ] Show-up/funnel recommendations (Wave 8 data) give the concrete revised sequence with evidence, written as steps to paste into Com.Bot / CloudShope
- [ ] WhatsApp agency briefs carry the implementation blocks verbatim — executable with zero strategic thinking on the agency side
- [ ] Governance unchanged: drafts and steps derive only from validated evidence + registered playbook; insufficient data says so; nothing auto-executes, owner approves before anything reaches an agency

### Wave 7 amendment 2 — consolidated four-specialist panel review (apply BEFORE building the Advisor)
All existing law stays absolute: contract gating, five-state trust, evidence validation, nothing auto-executes.

**Metric primacy**
- [ ] cost-per-offer-moment-attendee (CPOA) is the PRIMARY ranking/decision metric in every rule; CPL demoted to guardrail
- [ ] Every card shows a Quality Index = entity offer-present rate ÷ pooled median
- [ ] Personas compared on cost-per-sale-per-persona, never CPL

**Two speeds**
- [ ] Daily fast loop only: zero-lead fast-kill (spend ≥2× ref CPL with 0 leads) + existing z-anomaly flags
- [ ] Weekly strategic loop: scale / clone / rebalance / script-next / briefs

**Rulebook v2 (replaces v1 rules)**
- [ ] kill_ad, three sequential stages: (1) fast-kill as above; (2) early-kill n≥20 AND CPL >1.8× ref; (3) confirmatory n≥50 AND CPL >1.3× ref over 7d. ref = 28d same-weekday baseline, CPM-INDEXED so auction inflation never kills a healthy ad. QUALITY OVERRIDE: never CPL-kill anything with cost/60-min-attendee ≤0.9× portfolio median
- [ ] kill_adset: keep 1.5× / 14d / n≥30, but ref = trailing-28d pooled cost/60-min-attendee winsorised p5/p95 (never the drifting active-set median). Zombie rule: 1.1–1.5× for 21+ days while >10% of portfolio spend → recommend cap/derank
- [ ] LEARNING-PHASE GUARD (mandatory): no kill/scale on any adset with <50 leads since last significant edit or <7 days since launch; budget steps ≤20% and ≥72h apart; recommend batching all edits into one daily window
- [ ] scale_winner: dual entry CPL ≤0.9× ref AND cost/60-min ≤0.9× pooled median; "stable" = CV(daily CPL) <0.35 over 7d AND no |z|>2 day; step +20% max; 25% share cap stays
- [ ] clone_winner: trigger BEFORE fatigue (link-CTR decay slope negative 5+ consecutive days on a top-quartile ad); vary along hook/structure taxonomy axis or into the OTHER ad account — never claim "fresh audience"; post-clone guard: combined CPL of original+clone >10% worse within 7d → recommend merge-back
- [ ] fatigue v2: primary signal = trailing-7d link CTR ≥25–30% below the ad's own first-14d/peak CTR sustained 7d, min-spend gate ₹25k/window; CPM-indexed CPL 1.3× is confirmation only
- [ ] Lifecycle gains REFRESH (new hook on same body, iteration counter — a concept is FATIGUED only after ≥2 fresh executions also decay) and RESTING/REVIVABLE (fatigued PROVEN concepts revivable after 6–8 weeks)
- [ ] Concept transitions codified: TESTING→kill at spend ≥3× target CPL with 0 leads OR ≥30 leads with cost/60-min >1.5× baseline; TESTING→PROMISING ≥50 leads AND cost/60-min ≤ baseline; PROMISING→PROVEN ≥150 leads across ≥2 webinar cohorts AND ≥2 executions
- [ ] Budget band floor ₹4k/day; at 5× spend testing band ₹5–8k/day; testing share floor rises to 20% when monthly spend >₹25L; creative-age concentration warning — >50% of PROVEN spend on creatives >30d old = creative-cliff card
- [ ] Portfolio "next ads" engine replaces concept_gap-as-engine: weekly slate = 60–70% iterate-on-winners (new hooks on PROMISING/PROVEN bodies), 20–30% adjacent-new (concept_gap lives here, rescored: rank empty persona×pain cells by row/column MARGINAL performance, min 100 leads per marginal, empirical-Bayes shrinkage — never grid-order "adjacency"), 10% wildcards. Cadence: at ₹10L/mo ~1 net-new concept/week + 6–8 hook iterations/mo, scaled proportionally

**Attendance cross-tab (the moat)**
- [ ] Per single tag value and privileged pairs (hook×persona, persona×pain): offer-presence lift vs baseline with empirical-Bayes shrinkage + webinar-cohort fixed effect
- [ ] Tiers: n<100 SILENT; n≥100 AND raw gap ≥15pts AND ≥2 ads → "hypothesis, worth one iteration slot"; n≥300 AND 95% Wilson CI excludes baseline AND ≥2 cohorts AND ≥2 ads → recommendation
- [ ] NEVER 3-way combinations; NEVER when one ad contributes >70% of the cell; recompute per webinar cohort, not daily
- [ ] Negative alerts stated explicitly ("H5 buys cheap leads that don't show — CPL best, CPOA worst — stop cloning it")

**Taxonomy extensions**
- [ ] New tag dimensions: proof_type (none/founder-story/testimonial/stat/demonstration/authority), cta_framing (date-urgency/curiosity/identity/free-value), language_register (hindi/english/hinglish + formality), format_length (static/carousel/video <30/30-60/60-90/90s+; talking-head/b-roll/text; UGC/produced), messenger (founder/student/voiceover/faceless), awareness_stage (problem/solution/product-aware); split ad_promise vs course_promise
- [ ] LLM auto-tag the 11 existing scripts on the new dimensions; human-confirm queue

**Script diagnostic suite (zero sample size needed — build in Wave 7)**
- [ ] Message-match audit: ad promises vs webinar agenda, flag mismatches (top cause of pre-offer exits)
- [ ] Attendance-anchor checklist: does the script state date/time/"live"/reason-to-attend/calendar prompt
- [ ] Compliance inventory: personal-attribute, income and healing-claims language (Meta policy risk in wellness)
- [ ] Refusals NAME the confound and prescribe the de-confounding test ("S4 and founder-delivery perfectly confounded — test S4 with student messenger")

**Sales layer**
- [ ] Keep the 1,000-matched-lead hard gate; add a soft Beta-Binomial posterior below it as TIE-BREAKER ONLY between equal-CPOA concepts, always labelled low-confidence, never triggering kills

**Accountability v2**
- [ ] Every recommendation ships a PRE-REGISTERED machine-checkable success criterion + counterfactual convention frozen at issuance ("blended CAC improves ≥8% vs trailing 14d baseline by day 14"); scored mechanically, never LLM-graded
- [ ] Score REJECTED recommendations too (owner rejected "kill X"; X then did Y — advisor right/wrong)
- [ ] Track record PER RULE and per type on /advisor ("Scale calls: 9/13 met criteria")
- [ ] Regime flags: spend shifts >1.5× flag all track records + apply a confidence haircut
- [ ] Governance: no single recommendation moves >10% of monthly budget; weekly cap on cumulative advisor-driven moves; correlated-failure circuit breaker (≥3 same-family failures in a rolling window → family pauses + retro card); rules earn one-tap-approve only after ≥20 scored decisions at ≥70% success in the current regime; NOTHING ever auto-executes on budget
- [ ] When kill-recommending ≥4 similar adsets, recommend holding one at minimum budget as a counterfactual control

**Scale arithmetic on every scale card**
- [ ] Print the honest math: at current funnel rates, 750–1,000 sales/mo requires ~15–20× spend. Mandatory copy: scaling is a LADDER of ~1.5× steps, each gated and observed 4 weeks; conversion lifts (show-up, offer-present, close) are worth more than spend increases and change the ladder's economics

## Wave 8 — funnel spine + middle-of-funnel data (runs after Wave 7)
### A0. Recording capture — DONE (ran successfully after owner added scopes)
- [x] zoom_recordings table + private zoom-recordings storage bucket (2 GB/file); zoom_sessions.host_id; experiment_assignments table (empty substrate)
- [x] Capture job (/api/public/cron/capture-recordings): lists cloud recordings per matched session, stores metadata, persists small files (audio/chat/transcript) as bytes, keeps large video as link_only with expiry, resumable
- [x] UNBLOCKED (owner added scopes) — capture ran: 346 sessions swept, 139 with recordings, 833 files stored, 97 large videos link_only, 258 transcripts parsed (140,310 cues). Schedule the capture job hourly.
- [x] (was) BLOCKED ON OWNER: Zoom app needed scopes `cloud_recording:read:list_recording_files` and `cloud_recording:read:list_recording_files:admin` — nothing captured until added; then schedule the job hourly
- [ ] When wa_message_events / ivr_call_events are created in part C they must carry template_id and campaign_tag parsed from payloads where present

### A. Zoom chat sync + automatic offer-moment detection
- [ ] zoom_chat_messages (session_ref, sender_name, sent_at, message_text, is_offer_marker); extend Zoom sync to pull in-meeting chat per matched session (report exact missing scope names and stop that sub-task rather than guessing; handle UUID double-encoding)
- [ ] app_settings.offer_link_patterns (seed tagmango.com, rzp.io, razorpay, pages.razorpay); first matching chat message → zoom_sessions.offer_moment_at + offer_detect_source='chat'; no match = unmeasured, never a guessed minute
- [ ] offer_moment_attendance metric (÷ attendees and ÷ registrants, both labelled), contract-gated, n<30 rules; minutes-into-webinar of the offer per session; third L1 KPI on /show-up
- [ ] Keep raw chat unanalysed for later intelligence
### B. Meta clicks + click→registration proxy
- [ ] daily_metrics gains inline_link_clicks / impressions / derived CTR per ad/adset/campaign per day; 28-day backfill where the API allows
- [ ] Contracts: ctr (link CTR), click_to_registration (registrations ÷ link clicks per ad/page, n<30 guard, refuse where lead attribution is missing); surface in /funnel + /ads drill drawers; feed Wave-7 Advisor evidence
### C. Webhook receivers — Com.Bot (WhatsApp) + CloudShope (IVR)
- [ ] /ingest/whatsapp-events and /ingest/ivr-events public routes, per-source shared-secret token in app_settings, shown once on /settings; reject untokened requests; raw payload into webhook_events BEFORE parsing
- [ ] Tolerant parsers → wa_message_events / ivr_call_events, joined to leads by phone_key (last-10 rule)
- [ ] Metrics once real data flows: reminder delivery rate, reminder→attendance lift (n≥100 per arm), IVR answer rate, answered-call→attendance lift — all contract-gated; until then "connected, awaiting data" / "not connected"
- [ ] /settings "Automations" panel: URLs + tokens, per-source last-event timestamp, feed_config rows for both
### D. /funnel — the spine screen (last)
- [ ] Five connected stage cards: Attention, Landing, Automations→Show-up, Webinar hold, Conversion & follow-through; each with contract-gated rate, provenance mark, trend vs prior, status chip (measured / proxy / not connected)
- [ ] One money-weighted biggest-leak line from existing gated figures via the verdict materiality machinery
- [ ] Brief = chain + leak line; Working adds per-stage tables; default last7, standard RangeBar; sidebar link under Today

## Wave 9 — funnel intelligence (after Wave 8 data flows)
- [ ] 1. Offer decomposition as headline KPI: attendee→sale = P(present@offer) × P(buy|present), trended separately. Offer-timing scatter (offer-minute vs present% vs sales/attendee, ≥20 sessions); offer-consistency alarm (>10 min outside target window); pre-offer drop diagnosis distinguishing cliff at same absolute minute (script section bleeding — output "review minutes X–Y of these recordings"), cliff aligned to minutes-before-offer (pitch telegraphed), and drift (duration fatigue). Post-offer stay (10/20 min) + offer→payment latency (15m/60m/same-day)
- [ ] 2. HOT-LEAD LIST: 60 min after each webinar, ranked non-buyers who attended 60+ min AND were present at offer AND chat-engaged; pushed to /advisor + WhatsApp-copyable for the calling team
- [ ] 3. Registration-gap curve (show-up by 0-3h/3-8h/1d/2-3d/4-7d/8+d, min n=300/bucket, within-persona once n permits) + slot×persona matrix (n≥300/cell, shrunk below) → nearest-slot registration default, per-persona slot suggestion, "sell today's session" ad guidance
- [ ] 4. Reminder holdout engine on experiment_assignments: one variable at a time (T-30 vs T-60 final reminder, morning-of, reply-eliciting vs broadcast, IVR at delivered-unread only), 5–10% holdout, incremental attendance measured. Observational signals power a pre-webinar INTENT SCORE (ranking only, 2h before session) — never causal claims
- [ ] 5. Absentee lifecycle state machine: Fresh→NoShow1→NoShow2→Dormant→RetargetingPool→Archived; segment treatments (read-not-attended → opposite-slot re-invite; delivered-never-read → IVR; IVR-answered-still-absent → top of call queue); MAX-TOUCH CAP enforced; retargeting exports logged per lead; monthly absentee economics report (cost/recovered sale vs fresh CPL ₹385)
- [ ] 6. Deliverability funnel per template (sent→delivered→read; alerts delivered <95%, read declining >5pts/3wks); per-host scorecard (within-slot only, min 15 sessions, refuse cross-slot rankings); sale-timing cohorts (same-day/D1-3/D4-7/D8+) → if D1+ ≥30%, holdout-tested timed close sequence; buyer attendance fingerprint (flag if >15% of buyers were NOT present at offer); reattend-then-buy path (if >20% of buyers attended 2+ sessions, non-buyer re-invite is a revenue channel); class-size vs offer-present elasticity; duplicate-registration rate monitor (saturation canary)

## Wave 10 — money over time (the partner layer)
- [ ] 2. PACE-VS-TARGET FORECAST — **ships early, with Wave 9**: month-end L1 sales band, webinar-schedule-aware (expected = Σ remaining days' day-type effect × trailing conversion, negative-binomial interval), on the Morning Analyst + /weekly: "Tracking to 212 (180–245); P(≥250)≈15%; to close: +2 webinars or +12% conversion." Backtest vs naive run-rate for 8 weeks; kill it if it can't beat naive. NO other forecasting
- [ ] 1. COHORT LTV LEDGER (keystone, largest build): all revenue incl. ascension tiers joined to acquisition cohort/agency/campaign via email+phone identity (never platform attribution); cumulative ×-return per ₹1 curves at 30/60/90/180d per monthly cohort, front-end vs back-end split; JOIN-COVERAGE % displayed; five-state trust enforced ("back-end payback beyond 60d: not enough data — join coverage 71%"); no projection until ≥3 completed cohort curves
- [ ] 3. SCALE READINESS BOARD: ladder of ~1.5× steps only (₹10L→15→22→33→50), 6 gates per step — G1 unit economics (≥2 cohorts verifiably crossed 1.0× blended), G2 marginal returns (last step's marginal CAC ≤1.3× trailing avg), G3 cash (owner-entered monthly cash ≥ next step's float × (breakeven months+1)), G4 capacity, G5 quality (show-up + L1 conversion in control bands, no 4-week decay), G6 creative supply (required winners ≈ spend ÷ lifetime spend per winner; new ads ≈ winners ÷ hit rate). ONE honest card: "Cleared for ₹15L, not ₹50L. [reasons]. To unlock next step: [checklist]. Review: 4 wks after step stabilises." Gates OUTRANK the Advisor — a red gate freezes all step-up recommendations
- [ ] 4. CASH & FLOAT: owner enters monthly cash position in /settings; month-end cash band = committed spend + front-end forecast + scheduled promotions; per-step float requirement displayed
- [ ] 5. AGENCY SCORECARD on our normalized definitions — cost/verified-lead, show-up, L1 conversion, cohort revenue quality — serving the split/hire/fire decision; shared-account unattributables shown honestly
- [ ] 6. Marginal CAC estimator (spend-response from historical budget variation + designed step-ups); saturation dashboard (CPM z-score, duplicate-rate slope, show-up by spend decile, top-3-adset concentration); CAPI pipeline — server events Attended60 / OfferPresent (email+phone keys) + offline Purchase with real ex-GST ledger cash at 1–7d lag; NEVER switch testing adsets to attendance optimisation (volume-gated: consolidated campaigns only, ≥50 events/wk); recommend Conversion Leads goal if instant forms are ever used; new-account ramp module (seed in-house account with taxonomy-proven creatives, ≤20–30%/wk growth gated on convergence within 1.2× of main, combined-CPL cannibalisation check); structure advisor (fragmentation index; ABO test layer + consolidated PROVEN scaling campaigns, measure graduations); decision journal (every accept/reject + one-line reason, monthly "believed→decided→happened" calibration card); experiment designer (pre-registered metric + required-sample honesty: "this test needs 6 weeks at your traffic — no peeking")

## DO-NOT-BUILD (panel-vetoed)
No autonomous budget execution. No media-mix modeling. No what-if funnel simulator (assumed elasticities are laundered guesses — the gated ladder is the honest simulator). No long-horizon or ML forecasting. No per-customer propensity scores below 1,000 buyers/mo. No intraday streaming dashboards (defend the ≤3-cards discipline). No competitor scrapers. No unverifiable LLM commentary on dashboards. One veto overridden by owner directive: AI DRAFT SCRIPTS stay — evidence-grounded briefs for agencies, watermarked for owner approval, never a creative studio producing finished assets.

## Sequencing
UX waves 4–6 → Wave 7 (with both amendments) → Wave 8 → Wave 9 (+ pace-vs-target 10.2) → Wave 10. Dry-run audit on the Advisor before /advisor ships.



## Done — new ad account + auto-discovery (2026-09-06)
- act_1109475161619539 "Ritu Sabhi Digital P" reachable with the existing token; registered, assigned SD (owner-confirmed), backfilled 2026-08-12 → 2026-09-06: ₹1,77,572 spend, 481,073 impressions, 6,903 link clicks, 734 leads; 42 entities; account/campaign/adset/ad levels all reconcile to the same total.
- Auto-discovery (`src/lib/meta-discovery.server.ts`) runs inside every full Meta sync: enumerates /me/adaccounts, registers unknown accounts with agency_code=NULL, raises a "assign team" review item, marks vanished accounts not_visible_to_token (never deletes), logs the result per run. Manual route: /api/public/cron/discover-accounts (optional {probe}).
- Discovery marked 4 old read-only/disabled accounts not_visible_to_token — no data ever synced from them; left marked, not deleted.
- I-SYM / per-team ratios: coverage now 85.3% SD, 86.7% RJ, so ratios_computable flipped true. Added `agency_spend_status.ratios_valid_from` (SD 2026-08-01, RJ 2026-09-01, PRM null) and enforced it in FilterScope — a range starting before that date is still refused, so no retroactive per-team ratios in the shared-account era.

## Blocked — webinar transcript capture (2026-09-06)
- Capture job now looks for `audio_transcript` and `closed_caption` files first, downloads the VTT, stores the file in the private recordings bucket AND parses it into `recording_transcripts` (full text) + `recording_transcript_cues` (timestamped lines, speaker where Zoom names one). No analysis built.
- `POST /api/public/cron/capture-recordings {"probeLatest":true}` reports what file types exist for the most recent matched L1 session, and falls back to the account owner's own cloud-recording list when the session has no host email.
- RESOLVED: owner added the recording scopes and capture ran. 346 sessions swept (30 Nov 2025 - 6 Sep 2026), 139 with recordings, 207 without, 930 files found: 833 stored and 97 large screen-share videos kept as link_only. 258 transcript files parsed (140,310 cues). No API errors remain. Capture now runs hourly via pg_cron (25 * * * *), oldest sessions first.
- Owner-supplied transcript stored (2026-09-06): webinar_transcripts + webinar_transcript_lines, segment 1 (00:00-05:04) of the 18:45 IST session, 27 lines, last 3 flagged as music. Remaining segments are now fetchable and are stitched by recording-file start time. Owner confirms audio transcription IS enabled on the account, so audio_transcript files will exist.
- Full master script stored (2026-09-06): webinar_transcripts, coverage='full', is_canonical=true, 710 cues, 02:46:15, source manual_owner_upload, script v1, now linked to the 14:45 IST LIVE session (X8yXwkdeSP+QIFIW1D9xwg==). The earlier 5-min upload is coverage='intro_segment', is_canonical=false, and belongs to the 18:45 IST REPLAY session (pr8dEDT1Ti6dfrvhwQGQaQ==) — a different session, not a later segment of the same one.
- Transcript schema corrected 2026-09-08 (subsystem audit TR): segment_no now orders segments WITHIN one session only (both rows are segment 0 of their own session); session_ref carries a foreign key to zoom_sessions so the marker timeline can be aligned to the attendance curve; unique key is (session, segment_no, source); a partial unique index allows at most one canonical transcript per session; coverage is NOT NULL with a CHECK over full/intro_segment/offer_segment/partial/unknown. Preserved unchanged: actual_start_offset_ms = 955000 with every at_webinar_ms = at_ms - 955000.
- script_markers seeded (11, owner_verified). Canonical offer_moment = payment_link_dropped at 02:04:15 (7,455,000 ms / 124 min).

- Offer-consistency rule for the Wave 8 chat sync: when chat-detected link time AND script marker both exist, prefer the CHAT timestamp (actual) over the marker (intended); raise an alarm when they diverge by >10 min.
- Book My Seat: RESOLVED 2026-09-06 by owner ruling — a seat deposit is not a sale; the sale is recognised at the completing full payment, dated on that payment. Deposits stay in all cash metrics and render as a held-seats line. Ledger carries is_seat_deposit / seat_completed_at / seat_completion_of / counts_as_sale / revenue_recognized; recompute_seat_sales() runs after every ledger import; held_seats() and seat_completion_stats() feed the /sales held-seats line. Monthly goldens re-derived (Aug 201 -> 196) and paid Aug cash anchor re-derived to 8,84,145.33. Held-seats line still to be added to the Wave 8 /funnel screen when it is built.

## Severity triage (owner: "many error messages") — 2026-09-07
- [x] 1. attribution_purity: 09-01/09-02 were thin full-coverage days (7 and 5 sales), not a duplicated join — check versioned to need ≥8 sales, plus a new window-wide arm
- [x] 2. sales_count 09-04: fourth ledger sale is an unidentified ₹6,825.04 "Suspense" row with no email — recalibrated to carry one-sale gaps with named causes
- [x] 3. inv_spend_symmetry: rewritten with a 60-day clamp; now completes and runs daily
- [x] 4. cron manifest: ghl-backfill moved to on-demand; run-goldens-nightly confirmed running; creative-weekly not yet due
- [x] 5. inv_grain_integrity: same-day-only lag, current IST day now excluded from the check
- [x] 6. Three-tier severity language (red / amber / info) across Feed Health, Data Trust and the Today chip
- [x] Found while verifying: nightly ledger import and baseline rebuild had been failing every night (bare UPDATE rejected; statement timeout) — both fixed and re-run
- [x] Found while verifying: Today refused to render because the per-person lead lookup timed out after the full CRM import — replaced with an indexed per-buyer lookup

## Wave G — governance / self-protection (designed 2026-09-07, builds after P1-P5+S1-S5 → Wave 5/5b + acceptance sweep → D1-D8)
Order: G1, G2, G3 (each maps to a failure that actually happened), then G4, G5, G6, G7.

### G1. Rule-change propagation checklist
- [ ] `rule_changes` (rule_key, description, effective_from, changed_at, changed_by, status open|complete) + `rule_dependents` registry (rule_key → dependent_kind ∈ baseline|golden|contract|cached_aggregate|stored_brief|review_class, dependent_ref, how_to_reassert) + `rule_change_items` (change × dependent, status pending|reasserted|waived, note, resolved_at, resolved_by)
- [ ] Trigger on insert into rule_changes fans out one item per registered dependent; DB check refuses status='complete' while any item is pending; waived requires a non-empty note
- [ ] Items surface on /integrity (G5) with a one-click re-assert for goldens/baselines (calls the existing rebuild/run routes) and record what ran
- [ ] Backfill 2026-09-06 seat-deposit rule as change #1 with its real dependents (Aug golden 196, closed-month baselines, sales contracts, stored analyst evidence, BMS review class) marked reasserted — proves the mechanism against the case that caused it

### G2. Claim-vs-commit reconciliation
- [ ] `roadmap_items` (item_key, wave, title, claimed_complete, evidence_kind ∈ commit|sweep_row|query, evidence_ref, evidence_checked_at, verified boolean) — roadmap.md stays the human view, this table is the ledger
- [ ] `verify_roadmap_claims()` — every claimed_complete row with no resolvable evidence raises one review_item ("claimed complete, no evidence") and shows on /integrity; nightly + on demand
- [ ] Evidence resolvers: commit sha exists in history; acceptance-sweep row (G7) passing; verifying SQL returning true
- [ ] First run reports every currently-ticked item that cannot produce evidence — run as step one of the build, before any new ticks

### G3. Performance budget + self-reported degradation
- [ ] `query_budget` (query_key, label, expected_p95_ms, hard_ceiling_ms, note) and `query_timings` (query_key, ran_at, duration_ms, rows) written by the existing timedQuery wrapper (P5), retained 14 days
- [ ] Breach rules: rolling p95 > 3× expected, or any single call > ceiling → review_item + Feed Health degradation card naming the likely cause (stale statistics / missing index / data growth), chosen from last-ANALYZE age, plan shape and row-count drift
- [ ] Nightly stats-drift check per core table: live count vs count at last ANALYZE; drift >20% runs ANALYZE and logs it to `analyze_log` (table, before/after counts, ran_at, trigger)

### G4. Error triage ledger
- [ ] `error_signatures` (signature, sample_message, first_seen, last_seen, count, severity, blast_radius text[], disposition ∈ unclassified|fixed|accepted|watching, justification, updated_at); justification required when disposition='accepted' (DB check)
- [ ] Signature = normalised error text (SQLSTATE + shape, numbers/ids stripped); harvester folds sync_runs.error, review_items and server logs into it on every sync and nightly
- [ ] /integrity shows "unclassified errors — N" as an AMBER state; nothing can sit unexamined. Seed with the last 7 days

### G5. System integrity screen (/integrity)
- [ ] Brief by default, plain language, five sections: (a) VERIFIED TODAY — proofs, goldens, invariants with the date each LAST ACTUALLY RAN; (b) DEGRADED — late/stale/slow/failing with cause and who must act; (c) WHAT CHANGED — rule_changes + contract versions, dated; (d) PENDING — open review items grouped by owner (system / owner / agency) with what each waits on; (e) UNCLASSIFIED ERRORS
- [ ] AllClear guard applies to the screen itself: a section whose own query failed renders "could not load", never green, never zero

### G6. Daily self-diagnostic digest
- [ ] `self_diagnostics` (ran_at, checks jsonb, pass_count, fail_count, total_ms, verdict) written by /api/public/cron/self-diagnostic, once daily after the syncs
- [ ] Exercises the critical path: one representative query per screen, every proof, every golden, feed freshness, cron liveness, one render-gate probe with ?agency=SD (must refuse ratios)
- [ ] Any regression vs the previous pass raises a review_item and shows in DEGRADED

### G7. Acceptance sweep as a permanent gate
- [ ] `acceptance_matrix` (route, density, viewport, data_state, filter) × `acceptance_runs` (wave, cell, pass, note, ran_at) — a wave cannot be marked complete (G2) until its rows pass
- [ ] Current sweep results become run row one; future waves inherit the matrix automatically

## Backend audit (2026-09-07) — done
C1 lead→ad matching failure now fails the run + review item; backlog re-run (49,908 id / 6,822 name / 302 ambiguous).
C2 grain check skips the unfinished IST day. C3 cron alarm scoped to our own scheduled calls + separate "call accepted" check.
C4 all jobs go through public.cron_post with per-job timeout (weekly creative now completes in 2.8s).
C5 close pass scheduled daily; every kept item records why it stays open.
H1 Aug 2026 = 196 closed; close_finished_months() monthly. H2 brief uses max edge capped at yesterday + skip-if-exists + force honoured.
H3 transcript re-parse from storage (stored file no longer masks a missing transcript). H4 replay sessions excluded from attendance sanity.
M1 recordings feed registered. M2 ledger run row written before the first Sheets call. M3 429 backoff. M4 baselines job re-verified (22s, 40 rows).
Open: M5 Meta token nag (expires 2026-10-28), M6 raised as owner action.

## S1 — team-filter gate defect (2026-09-07) — DONE
- Gate no longer switches itself off when a team becomes ratio-allowed; the team dimension is active whenever `?agency=` is set.
- Coverage is a second, narrower gate (`agencyNeedsCoverage` on contracts), never a global override.
- `agency_spend_status.ratios_hold` kill-switch added; `refresh_agency_ratio_flags` respects it.
- Verified with flags ON: ROAS, headroom and blended ratio refuse under `?agency=SD` and `?agency=RJ`, in a pre- and post-valid-from window; unfiltered still renders 0.48x.

## Next (from the wiring audit)
W1 teamless accounts review items + unattributed share · W2 rename products.counts_as_sale · W3 cost_per_sale / sales_per_1000_leads onto the ledger rule + goldens + narrow watchdog · W4 declare the three spend universes · W5 FilterScope on all routes, kill hard-coded "22.6% of sales" · W6 session_t0 fallthrough · W7 correct Wave 8C claim · W8 transcripts unread + breaker verification

- [x] Zoom host sweep: skip-list in app_settings (4 unlicensed logins, weekly re-probe, informational not error); host_id SY8kgRkfQJuELb6hUaMmpA = creative@energyqueenshub.com; 108/126 null-host sessions recovered, 18 unrecoverable (2026-05-25..06-05); L1 runs as webinars (209) and meetings (138) — both endpoints swept.

## PG3 — long windows (done, verified)
Heavy report functions were being cut off at the 8s API statement timeout.
Timed each: metric_components 10s, zoom_event_rows 9s, zoom_session_rows 18s,
sales_reconciliation 27s. Raised statement_timeout to 60s per function (12
functions) — still inside the page's own wait. Matrix of 8 routes x 7 presets:
0 failures, "This year" renders on /, /ads, /sales, /show-up.

## PG1 — coverage-shift comparison guard (done)
Today's KPIs no longer print a change against a prior period whose measured
share of spend moved 10+ points; the delta is suppressed with the two coverage
percentages named. Prevents the ₹276 → ₹466 "trend" that was a denominator move.

## Subsystem wiring audit (2026-09-08)

### SEC1 — exposure, honestly
Verified against the live host, not the source: `GET /` returns **403 Forbidden**
to any caller without a Lovable workspace session, and so does every page and
every server-function RPC. `/api/public/cron/*` returns **401** without the job
key. So the P&L, buyer emails and phone numbers were NOT reachable by an
outsider at any point — the platform gate held. What was true: the app itself
had no second lock, `attachSupabaseAuth` / `requireSupabaseAuth` were unimported
and gated nothing, and `auth.users` holds 0 rows, so switching them on would
lock the owner out until accounts exist. Done now: CSRF protection extended from
server functions only to the whole app, with `/api/public/*` (out-of-browser
callers, own key check) exempt. Awaiting owner decision: Lovable workspace
identity vs named email/Google accounts. Do not enable a sign-in gate before
that answer — there is nobody to sign in as.

### SEC2 — scheduled-job caller
Key removed from the body of `cron_post` and read from `app_settings.cron_api_key`
(rotate in one row). It is the publishable key, not a secret, but it should not
be embedded in a function body. Host: `cron_base_url` still points at the stable
PREVIEW host because the dashboard is not published — the production host would
404 today. `cron_base_url_note` records that it must be flipped on first publish.
Both hosts serve the same single Cloud database, so no "dev data" exists to
diverge; the risk was availability, not data.

### LG — load guard is now structural
New `src/lib/cron-job.server.ts` (`runGuardedJob` + `guardedResponse`) is the one
door: breaker check, retry with backoff, shared stand-down, and a skip reported
as a skip rather than a success. Wired: meta-sync, ledger-sheet,
tagmango-payments, ghl-leads, creative-sync, proof, queue-verify — plus the two
already guarded internally (zoom-recordings, ghl-backfill).
LG2: `withRetry` is now the only path to a failure, so `CircuitOpenError` is
reachable and `ghl-backfill.ts:339` is no longer dead. `clearBreaker` is wired to
a **"Let background jobs run again"** control on /trust, next to a
**"Re-run the checks now"** control (which also closes the missing /trust re-run).

### QT — slow-query alarm installed
`reportIfSlow` is called from `request()` in `src/lib/pg.server.ts`, so EVERY
database round trip is timed, not the handful an author remembered to wrap. Label
collapses per RPC/table so one drifting query raises one review item. A
re-entrancy latch stops the reporter reporting its own writes.

### CR — no invisible endpoints
`verify-queue-daily` was in fact already scheduled (0 7 * * *) — audit claim was
wrong; its open items are a verification-logic matter, not a scheduling one.
`discover-accounts` was genuinely missing: now scheduled weekly (15 2 * * 1) and
in the manifest. `zoom-host-backfill` and `seed-scripts` registered as explicit
on-demand. Rule enforced by `src/lib/cron-routes.ts` + `cron-routes.test.ts`: a
new endpoint file that is not declared with a schedule or "on demand" fails the
test.
CR2: account discovery is now an explicit `discover` option; the nightly cron
sets it on the daily-grain pass only, so one enumeration per cycle instead of two
— and it no longer disappears when the run is narrowed to named accounts.

### TR — transcript schema (see the Wave 8 section above for detail)
All five defects fixed before any reader exists.

### Dead code
Deleted `src/lib/sales.functions.ts` entirely (9 unreferenced exports, including
a second divergent TagMango sync trigger). Deleted the four unreferenced
server functions `rebuildBaselines`, `getUnmatchedBuyers`, `seedAndTag`,
`runCreativeIngest` — each has a scheduled route running the same server code.
Dropped the 2-arg `ledger_reconciliation` overload (PGRST203 hazard).
STILL OPEN: `golden_status` / `deploy_status` SQL functions vs the hand-assembled
read in GoldenStatusPanel — pick one; not touched this pass.

## Page-by-page re-audit (in progress)

Done: green all-clear (1,2), slot show-up rate (3), sales cash labels (4,5),
false-zero reads on pages/creative/weekly/ads (6), queue chips + bulk scope (7,8),
ads delta suppression (9), weekly week clamp (10), modelled scaling wording (11),
coverage bar unknown state (16), sections show a notice instead of vanishing (17),
compare control gated (18), Brief switch live everywhere (19), retry on Feed
Health (21), permanently empty tiles removed (22), errors inside the shell (23),
plain-English status wording, light/dark control, real page titles.

Open: lead-tracking panel in Settings (20), one name per concept sweep (25,26),
row click affordances (27), pages Brief see-all polish (29,30), queue section
order (31), ads chart team scope (32), touch-friendly hover notes (13),
proof table unknown vs zero (14), trust hardcoded paragraph (12),
remaining jargon sweep (T3), phone layout pass (T4).

## Fresh numbers re-audit (N1–N8)
- [x] N1 team split on the money side — MV refreshed, daily 05:20 job, refreshed inside refresh_lead_agency, both money paths on one source, unknown team no longer counts as spend-verified
- [x] N2 cost per sale — metric_series now uses total spend per contract v3; /sales hint corrected; rule change recorded
- [x] N3 corrupt outstanding amount — ingest quarantine + owner review item; live row blanked
- [x] N6 stale baselines — rebuilt; bulk re-derivation now triggers a rebuild
- [ ] N4 mix-vs-efficiency decomposition, regime notice coverage, RJ July spend backfill
- [ ] N5 split live vs replay in show-up/retention; present-at-T relabel; dedup rows out of completeness counter
- [ ] N7 contract drift re-fingerprint; goldens witnessed independently; wire inv_basis_symmetry + inv_unwitnessed_spend into nightly
- [ ] N8 sample gate on money-per-event metrics; pre-ad paid cash guard; preset window labels; 15 Apr / 4 Mar sales with no webinar; EMI Offer counts_as_sale; per-team cost per sale and ROAS; back-end return figure

## Owner facts 7 Sep (O1–O5)
- [x] O1 corrected webinar start times (15:00/19:00), effective-dated slot schedule, retention recomputed, offer minute re-anchored
- [x] O2 simulive recorded: session_format, script-version transcript coverage, offer deviation measured against the script's fixed minute, no host scorecard for L1
- [x] O3 four non-webinar logins permanently skipped by design; review item closed
- [x] O4 Zoom sync run; cadence moved to 16:30/18:30/22:30/04:30 IST so the 7pm session lands same day
- [x] O5 one-time-code sign-in live, all screens and all 73 server functions gated
- [ ] Per-session payment-link capture (chat) so offer-deviation stops reading "no data"
- [ ] Brief/Working still has nothing to shorten on weekly, trust, health, queue, settings, agencies, funnel, revenue, spend — the switch now says so
- [ ] V7 claim-vs-evidence reconciliation, V8 remaining job guards, V9 acceptance sweep

## Phase 2
- [x] P2-A Back-end return by acquisition month (`/cohorts`), all-tier return tile on Today, two closed-cohort checks (Apr/May 2026 at 90 days).
- [ ] P2-B Per-team economics: cost per sale, front-end return, cost per 60-minute attendee, cost per offer-moment attendee, back-end return, real Sales column in the team table, SX kept separate, team-ratio hold release only after two consecutive on-schedule symmetry passes.

## Sabhi agency emails (26 Sep)
- [x] Daily (6:30 p.m. IST) + weekly (Wed 10:00 IST) to aditya@sabhidigital.com, owner cc — schedules off until acceptance approved
- [x] Amendment: exclude 587640350334915 and 699110549552181 by name; Sabhi = 1249430309131428 + 1109475161619539 + Google; 1488704194840585 shows "no spend this month"
- [x] Amendment: Google paused since 26 Aug 2026 — September Google sales labelled as earlier registrations; click-identifier item phrased as fix-before-restart
- [x] No other agency's numbers anywhere; no per-account buyer comparison on screens while dispute is open
- [ ] Form to log a Sabhi reply as a review item (waits on owner approval of test emails)
- [ ] Switch on both Sabhi schedules (waits on owner's check of the test emails)
