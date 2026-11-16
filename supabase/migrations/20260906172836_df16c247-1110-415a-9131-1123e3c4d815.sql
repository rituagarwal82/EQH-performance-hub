CREATE TABLE IF NOT EXISTS public.webinar_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_match_hint text NOT NULL,
  session_ref text,
  segment_no integer NOT NULL DEFAULT 1,
  effective_from date NOT NULL,
  source text NOT NULL DEFAULT 'manual_owner_upload',
  script_version integer NOT NULL DEFAULT 1,
  file_name text,
  language text,
  vtt_raw text NOT NULL,
  covers_start_ms integer,
  covers_end_ms integer,
  line_count integer NOT NULL DEFAULT 0,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_match_hint, segment_no, source)
);

CREATE TABLE IF NOT EXISTS public.webinar_transcript_lines (
  id bigserial PRIMARY KEY,
  transcript_id uuid NOT NULL REFERENCES public.webinar_transcripts(id) ON DELETE CASCADE,
  line_no integer NOT NULL,
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  speaker text,
  text text NOT NULL,
  is_music boolean NOT NULL DEFAULT false,
  UNIQUE (transcript_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_webinar_transcript_lines_t ON public.webinar_transcript_lines(transcript_id, line_no);
CREATE INDEX IF NOT EXISTS idx_webinar_transcripts_hint ON public.webinar_transcripts(session_match_hint, segment_no);

GRANT SELECT ON public.webinar_transcripts TO authenticated;
GRANT SELECT ON public.webinar_transcript_lines TO authenticated;
GRANT ALL ON public.webinar_transcripts TO service_role;
GRANT ALL ON public.webinar_transcript_lines TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.webinar_transcript_lines_id_seq TO service_role;

ALTER TABLE public.webinar_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webinar_transcript_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "signed-in users read webinar transcripts" ON public.webinar_transcripts
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "signed-in users read webinar transcript lines" ON public.webinar_transcript_lines
  FOR SELECT TO authenticated USING (true);

CREATE TRIGGER update_webinar_transcripts_updated_at
  BEFORE UPDATE ON public.webinar_transcripts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();