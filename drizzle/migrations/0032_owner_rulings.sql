CREATE TABLE public.owner_rulings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section text NOT NULL,
  ord integer NOT NULL DEFAULT 100,
  title text NOT NULL,
  body text NOT NULL,
  decided_by text NOT NULL DEFAULT 'Owner',
  decided_on date,
  why text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.owner_ruling_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ruling_id uuid REFERENCES public.owner_rulings(id) ON DELETE CASCADE,
  action text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  changed_by text,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX owner_rulings_section_idx ON public.owner_rulings(section, ord);
CREATE INDEX owner_ruling_changes_ruling_idx ON public.owner_ruling_changes(ruling_id, changed_at DESC);

GRANT SELECT ON public.owner_rulings TO authenticated;
GRANT SELECT ON public.owner_ruling_changes TO authenticated;
GRANT SELECT ON public.owner_rulings TO anon;
GRANT SELECT ON public.owner_ruling_changes TO anon;
GRANT ALL ON public.owner_rulings TO service_role;
GRANT ALL ON public.owner_ruling_changes TO service_role;

ALTER TABLE public.owner_rulings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owner_ruling_changes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rulings readable" ON public.owner_rulings FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "rulings service" ON public.owner_rulings FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "ruling changes readable" ON public.owner_ruling_changes FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "ruling changes service" ON public.owner_ruling_changes FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.owner_rulings (section, ord, title, body, decided_by, decided_on, why) VALUES
('A', 10, 'What counts as an L1 sale',
 'An L1 sale is a row marked "New Sale" in the accounts ledger for the L1 Silver product. Two bases are always shown: "Sales" (the team''s count, matching their sheet) and "Fully paid". A seat deposit counts as a sale only once it is fully paid. Reference months, owner-verified: May 2026 = 258, June 2026 = 283, July 2026 = 248.',
 'Owner', '2026-09-14', 'The accounts ledger is the only record of money actually received, so it decides what a sale is.'),
('A', 20, 'This engine is for L1',
 'Other purchases (Diamond, retreats, anything else) appear only as "what these buyers spent later" — never inside the L1 sale count, cost per sale or return.',
 'Owner', '2026-09-14', 'Mixing tiers would make the cost of acquiring a first-course buyer impossible to read.'),
('A', 30, 'One GST basis, always named',
 'Every money figure states its GST basis and the same basis is used everywhere on a screen. Break-even and return are gross: no fees, commission, delivery cost or refunds at this level.',
 'Owner', '2026-09-14', 'A rupee figure without its tax basis is not comparable to anything.'),

('B', 10, 'The first-touch law',
 'A sale''s source belongs to the buyer''s FIRST registration — the first click that brought them into our world — and to the agency and platform behind it. Later campaigns that remind or retarget an existing lead never take the credit.',
 'Owner', '2026-09-11', 'Otherwise the last advert a buyer happened to see would steal the credit from whatever actually found them.'),
('B', 20, 'Retargeting never overwrites a source',
 'Campaigns aimed at people we already have — podcast retargeting, the Inhouse Lead Campaign, voucher and next-chapter offers, the ₹999 offers — never change a person''s recorded source.',
 'Owner', '2026-09-11', 'They speak to people we already paid to find once.'),
('B', 30, 'Order of evidence',
 'Hard tracking first (the link''s campaign and source, and the ad account behind the ad), then the team''s "Source of Student" column in the ledger, then the team''s source register sheet. Where the team disagrees with hard evidence, tracking wins and the case goes to a review list — nothing is ever overwritten silently.',
 'Owner', '2026-09-14', 'People remember; links record. Both are kept, and disagreements are visible instead of hidden.'),
('B', 40, 'How a payment is matched to a person',
 'By email first, then a confirmed team link between two addresses, then the payer''s phone number — and only when that number belongs to exactly one person.',
 'Owner', '2026-09-14', 'A guessed match would move money to the wrong team.'),

('C', 10, 'Who the agencies are',
 'Sabhi Digital (Meta and Google, always shown separately) · Rajdeep, in-house · Parami — spelled "Parnami" by their own team — live from 17 September 2026 · ScaleX, closed July 2026 · Tushar, closed 2025 · Vlad, tried in 2025 and closed.',
 'Owner', '2026-09-20', 'Every rupee of spend has to belong to someone who can be judged on it.'),
('C', 20, 'Ad-account ownership is date-effective',
 'When an ad account changes hands, its history stays with the previous owner. The past is never relabelled. Example: the account "Ritu Agarwal-SX-2" is ScaleX up to 4 July 2026 and Parami from 17 September 2026.',
 'Owner', '2026-09-15', 'Rewriting history would silently change months that were already signed off.'),
('C', 30, '"TS_" campaigns belong to Sabhi Digital',
 'All campaigns starting "TS_" are Sabhi Digital, not Tushar — proven by the ad account they ran on. Tushar keeps only leads with genuine separate evidence.',
 'Owner', '2026-09-14', 'The campaign name looked like a person''s initials; the ad account showed who actually ran it.'),
('C', 40, 'The Google campaigns were Sabhi Digital',
 'The "DG_" and "B_DG_" campaigns were run by Sabhi Digital. Google spend is not connected to this engine, so Google cost figures cannot be shown — only the sales and leads that came from it.',
 'Owner', '2026-09-14', 'Sabhi''s total work includes Google, but the cost side of it is not measurable here yet.'),
('C', 50, '"EQH_SD" is a retargeting and brand account',
 'It is not lead generation and is never judged on cost per lead.',
 'Owner', '2026-09-12', 'Judging a brand account on cost per new lead would condemn it for doing its job.'),
('C', 60, '"Japan_" campaigns are only a name',
 'They were named while the team was travelling. They are not a geography, an audience or a programme.',
 'Owner', '2026-09-14', 'The name invites a wrong reading of the numbers.'),
('C', 70, 'The ₹47 / ₹49 funnels and "EQM"',
 'The ₹47 and ₹49 paid-webinar funnels were ScaleX''s experiment and closed in early 2026. "EQM" means Energy Queens Masterclass — the name of the L0 webinar, never a traffic source.',
 'Owner', '2026-09-13', 'Both were being read as sources of their own.'),

('D', 10, 'Podcasts and influencers are named individually',
 'Bhanu, Gunjan, Dr Shikha, Vikas Nagru, Bharti, Riya Upreti, Manogya, Namit Talks, Anchal. Each is its own source, never pooled into one "influencer" bucket.',
 'Owner', '2026-09-14', 'Pooling them hides which relationship is actually worth the time.'),
('D', 20, 'Collaborations are free',
 'Siddharth Rajshekhar (SIDZ), Vivek Mashrani (TechnoFunda), Shweta Samota (SWETAS), Avinash Mada (FWAIEQH) and Badri bring students in free. Their students never count as sales or revenue — collaboration is a registration source only. If such a person later pays for anything, the collaboration keeps the credit for that sale.',
 'Owner', '2026-09-14', 'Counting free students as sales would flatter every ratio on every screen.'),
('D', 30, '"DESDKit" is not a source',
 'It is treated as blank and never displayed as a source.',
 'Owner', '2026-09-14', 'It is an internal label that leaked into the source field.'),
('D', 40, 'Talks and offline events',
 'Talks such as the YFLO talk of September 2026 are their own family. They are never paid, carry no spend, and so show counts only — no cost or return figures. Their sales count normally.',
 'Owner', '2026-09-19', 'Real leads with no media cost behind them.'),

('E', 10, 'Campaign naming',
 'Every campaign name starts with the agency''s own prefix, so the campaign alone says who ran it even if everything else is missing.',
 'Owner', '2026-09-14', 'It is the last line of defence when link tagging fails.'),
('E', 20, 'The link tagging every ad must carry',
 'Every ad''s link must carry the full parameter template, with the team''s own source value: utm_source=FACEBOOK_P for Sabhi Digital, FACEBOOK_RJ for Rajdeep, FACEBOOK_PRM for Parami. The rest of the template is utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{adset.name}}&utm_term={{ad.name}}&ad_id={{ad.id}}',
 'Owner', '2026-09-14', 'Without it there is no way back from a lead to the advert that produced it.'),
('E', 30, 'Only tested registration pages',
 'Paid traffic goes only to registration pages we have tested end to end. Offline talks use utm_source=talk_<organisation> on the QR code or link shared at the event.',
 'Owner', '2026-09-19', 'An untested page can take money all day and record nothing.'),
('E', 40, 'What it costs when this is skipped',
 'Ad-level detail is lost permanently — it cannot be reconstructed later. This is currently the case for Parami since 17 September 2026, and for the in-house page that sent the literal word "source" from 17 July to 11 September 2026.',
 'Owner', '2026-09-19', 'The agency total stays right, but no advert inside it can ever be judged.'),

('F', 10, 'Google spend is not connected',
 'Sabhi Digital''s Google sales and leads are counted; the money behind them is not, so no Google cost or return figure can be shown.',
 'Owner', '2026-09-14', 'Nobody should read a Google cost figure that does not exist.'),
('F', 20, 'Payments recorded as "Suspense"',
 'Some payments in the ledger carry no buyer. They are cash, but they belong to nobody until the accounts team names the person.',
 'Owner', '2026-09-14', 'Guessing a buyer would corrupt both the sale count and the source.');
