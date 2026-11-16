CREATE TABLE public.concept_draft_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_item_id uuid NOT NULL UNIQUE,
  concept_key text NOT NULL,
  in_words text NOT NULL,
  hook text NOT NULL,
  body text NOT NULL,
  close text NOT NULL,
  drew_on text NOT NULL,
  edited_by_owner boolean NOT NULL DEFAULT false,
  model text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.concept_draft_scripts TO authenticated;
GRANT ALL ON public.concept_draft_scripts TO service_role;

ALTER TABLE public.concept_draft_scripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in team can read drafts"
  ON public.concept_draft_scripts FOR SELECT TO authenticated USING (true);

CREATE POLICY "Signed-in team can edit drafts"
  ON public.concept_draft_scripts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
