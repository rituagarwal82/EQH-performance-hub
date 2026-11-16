ALTER TABLE public.webinar_transcripts
  ADD COLUMN IF NOT EXISTS is_canonical boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS coverage text;

CREATE TABLE IF NOT EXISTS public.script_markers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id uuid NOT NULL REFERENCES public.webinar_transcripts(id) ON DELETE CASCADE,
  marker_key text NOT NULL,
  label text NOT NULL,
  at_ms integer NOT NULL,
  is_offer_moment boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'owner_verified',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transcript_id, marker_key)
);

CREATE INDEX IF NOT EXISTS idx_script_markers_t ON public.script_markers(transcript_id, at_ms);

GRANT SELECT ON public.script_markers TO authenticated;
GRANT ALL ON public.script_markers TO service_role;

ALTER TABLE public.script_markers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "signed-in users read script markers" ON public.script_markers
  FOR SELECT TO authenticated USING (true);

CREATE TRIGGER update_script_markers_updated_at
  BEFORE UPDATE ON public.script_markers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();