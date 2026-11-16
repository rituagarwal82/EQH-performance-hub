
-- Ruling 3: ScaleX paid-webinar experiment (_47Paid / _49Paid), previously junk.
UPDATE public.source_dictionary
   SET channel_group = 'ScaleX (agency, closed)',
       display_name  = 'ScaleX paid webinar (₹47/₹49 ticket, closed)',
       is_acquisition = true, is_paid = true, confidence = 'confirmed',
       note = 'ScaleX paid-ticket L0 experiment, closed earlier this year',
       updated_at = now()
 WHERE layer = 'ghl_source' AND raw_value = '_47Paid';

INSERT INTO public.source_dictionary
  (raw_value, layer, match_kind, channel_group, display_name, is_acquisition, is_paid, confidence, note)
VALUES
  ('_49Paid','ghl_source','exact','ScaleX (agency, closed)','ScaleX paid webinar (₹47/₹49 ticket, closed)',true,true,'confirmed','ScaleX paid-ticket L0 experiment, closed earlier this year'),
  ('_47Paid','utm','exact','ScaleX (agency, closed)','ScaleX paid webinar (₹47/₹49 ticket, closed)',true,true,'confirmed','ScaleX paid-ticket L0 experiment'),
  ('_49Paid','utm','exact','ScaleX (agency, closed)','ScaleX paid webinar (₹47/₹49 ticket, closed)',true,true,'confirmed','ScaleX paid-ticket L0 experiment'),

  -- Ruling 5: Vlad, a marketing agency tried in 2025, now closed.
  ('Vlad','ghl_source','prefix','Vlad (agency, closed)','Vlad (agency, closed)',true,true,'confirmed','Front-end lead agency tried in 2025'),
  ('YTVlad','ghl_source','prefix','Vlad (agency, closed)','Vlad (agency, closed)',true,true,'confirmed','Front-end lead agency tried in 2025'),
  ('Vlad','utm','prefix','Vlad (agency, closed)','Vlad (agency, closed)',true,true,'confirmed','Front-end lead agency tried in 2025'),
  ('Vlad','utm_campaign','prefix','Vlad (agency, closed)','Vlad (agency, closed)',true,true,'confirmed','Front-end lead agency tried in 2025'),

  -- Ruling 6: Manogya is an influencer podcast.
  ('manogya','ghl_source','prefix','Influencer podcast','Podcast: Manogya',true,false,'confirmed','Influencer podcast, owner-confirmed'),
  ('manogya','utm','prefix','Influencer podcast','Podcast: Manogya',true,false,'confirmed','Influencer podcast, owner-confirmed'),
  ('Podcast_Manogya','utm_campaign','prefix','Influencer podcast','Podcast: Manogya',true,false,'confirmed','Influencer podcast, owner-confirmed'),

  -- Ruling 2: Japan_% are ordinary ad names; every Japan campaign ran on a
  -- Sabhi Digital Meta ad account (verified against ad_entities/ad_accounts).
  ('Japan_','utm_campaign','prefix','Meta ads','Sabhi Digital (Meta)',true,true,'confirmed','Ad names coined while travelling; ran on SD Meta accounts, not a separate programme'),

  -- Ruling 9: B_YT_ is YouTube custom intent = Google Ads, split at the stop date.
  ('B_YT_','utm_campaign','prefix','Google Ads','Google Ads',true,true,'confirmed','YouTube custom intent — Google paid era'),

  -- Ruling 1: campaigns that retarget our own lead list never claim a source.
  ('Inhouse','utm_campaign','prefix','Not acquisition','Existing-lead campaign',false,false,'confirmed','Retargets our own list — first touch keeps the source'),
  ('Poadcast_free_webinar','utm_campaign','prefix','Not acquisition','Existing-lead campaign',false,false,'confirmed','Retargets our own list — first touch keeps the source'),
  ('voucher-leads-next-chapter','utm_campaign','prefix','Not acquisition','Existing-lead campaign',false,false,'confirmed','Retargets our own list — first touch keeps the source'),
  ('999email','utm_campaign','prefix','Not acquisition','Existing-lead campaign',false,false,'confirmed','Retargets our own list — first touch keeps the source'),
  ('voucher-leads-next-chapter','ghl_source','prefix','Not acquisition','Existing-lead campaign',false,false,'confirmed','Retargets our own list — first touch keeps the source'),
  ('Poadcast_free_webinar','ghl_source','prefix','Not acquisition','Existing-lead campaign',false,false,'confirmed','Retargets our own list — first touch keeps the source');

INSERT INTO public.source_dictionary
  (raw_value, layer, match_kind, channel_group, display_name, is_acquisition, is_paid, confidence, valid_from, note)
VALUES
  ('B_YT_','utm_campaign','prefix','Organic search','Organic search',true,false,'confirmed','2026-08-27','YouTube after the Google paid stop date');
