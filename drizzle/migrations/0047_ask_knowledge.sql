CREATE TABLE IF NOT EXISTS public.ask_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  kind text NOT NULL DEFAULT 'finding',
  body text NOT NULL,
  ord integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  source_note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ask_knowledge TO authenticated;
GRANT ALL ON public.ask_knowledge TO service_role;

ALTER TABLE public.ask_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users read knowledge" ON public.ask_knowledge
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Signed-in users edit knowledge" ON public.ask_knowledge
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE public.ask_log ADD COLUMN IF NOT EXISTS understood text;
ALTER TABLE public.ask_log ADD COLUMN IF NOT EXISTS plan jsonb;
ALTER TABLE public.ask_log ADD COLUMN IF NOT EXISTS corroborated boolean;

INSERT INTO public.ask_knowledge (topic, kind, body, ord, source_note) VALUES
('Business day', 'rule', 'The business day runs 06:00-05:59 IST and is already stored as business_date on every table. "Today", "yesterday", "this week" and "this month" always mean business days in IST.', 10, 'Owner rule'),
('What counts as a sale', 'rule', 'A sale is a new L1 Silver sale in the accounts ledger (ledger_inflow, is_new_sale=true, product_tier=''L1_SILVER''). Money is ledger_inflow.amount_received, never TagMango. Book My Seat deposits are not sales until the full payment lands.', 20, 'Decisions & Rules page'),
('The two counting bases', 'rule', 'Two bases exist and must never be mixed: all L1 cash received on a day, versus cash against sales tagged new on that day. Always name which basis a money figure uses.', 30, 'Decisions & Rules page'),
('Ledger lag and TagMango', 'rule', 'The accounts sheet is typed by hand and normally lags by up to 3 days, so the last few days are always incomplete. For timely counts use TagMango enrolments (tm_enrolments joined to products where counts_as_sale). Never report an empty ledger day as zero sales - state the ledger position and check TagMango.', 40, 'Owner rule'),
('Attribution', 'rule', 'First touch wins: a lead belongs to the source that first brought them in. Collaborations and podcast appearances are free and never count as paid sales. Google and YouTube tagged leads carry no Google click id - Google Ads is not running, so they are organic search and old campaign links with no media cost.', 50, 'Decisions & Rules page'),
('Agencies', 'rule', 'Agency codes: SD Sabhi Digital, RJ Rajdeep (in house), PRM Parami, SX ScaleX (closed). Ownership of an ad account is date effective - an account can change agency mid-period.', 60, 'Decisions & Rules page'),
('Webinar offer timing', 'finding', 'The offer falls at about 108 minutes into the webinar, so watch depth is the single strongest purchase signal.', 70, 'Standing finding'),
('Buy rate by watch depth', 'finding', 'Buy rate is 10.12% among registrants who watch 90+ minutes, against 0.46% to 1.21% below that. 73% of all buyers watched 90+ minutes.', 80, 'Standing finding'),
('Later value by watch depth', 'finding', 'Deep-watch buyers spend Rs 49,222 more in the following 90 days, against Rs 28,156 for non-attenders.', 90, 'Standing finding'),
('Deep watch predicts ad quality', 'finding', 'An ad''s deep-watch rate tracks its cost per sale: ads that produce deep watchers produce cheaper sales.', 100, 'Standing finding'),
('Ad verdict thresholds', 'rule', 'Below Rs 9,000 a sale: consider scaling. Above Rs 12,000 a sale: consider stopping. In between: no verdict. Never judge an ad or segment with fewer than 30 registrations in the window - say it is too early.', 110, 'Owner rule'),
('Webinar slots', 'rule', 'Two slots run daily in IST: afternoon (start 11:00-16:59, the 3PM session) and evening (17:00-22:00, the 7PM session). All timestamps are stored in UTC.', 120, 'Owner rule'),
('Scope', 'rule', 'Only the L1 (Silver) offer is in scope unless the question names another tier. All money is INR, with Indian digit grouping. Break-even and ROAS are gross only - no fees, commission, delivery cost or refunds.', 130, 'Owner rule')
ON CONFLICT (topic) DO NOTHING;