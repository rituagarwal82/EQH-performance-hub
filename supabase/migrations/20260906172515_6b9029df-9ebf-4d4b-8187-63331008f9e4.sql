CREATE TABLE IF NOT EXISTS public.recording_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_ref text NOT NULL,
  recording_id text NOT NULL,
  source_type text NOT NULL,               -- audio_transcript | closed_caption | cc_transcript
  storage_path text,
  language text,
  cue_count integer NOT NULL DEFAULT 0,
  duration_ms integer,
  full_text text NOT NULL DEFAULT '',
  captured_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_ref, recording_id)
);

CREATE TABLE IF NOT EXISTS public.recording_transcript_cues (
  id bigserial PRIMARY KEY,
  transcript_id uuid NOT NULL REFERENCES public.recording_transcripts(id) ON DELETE CASCADE,
  cue_index integer NOT NULL,
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  speaker text,
  text text NOT NULL,
  UNIQUE (transcript_id, cue_index)
);

CREATE INDEX IF NOT EXISTS idx_transcript_cues_transcript ON public.recording_transcript_cues(transcript_id, cue_index);
CREATE INDEX IF NOT EXISTS idx_recording_transcripts_session ON public.recording_transcripts(session_ref);

GRANT SELECT ON public.recording_transcripts TO authenticated;
GRANT SELECT ON public.recording_transcript_cues TO authenticated;
GRANT ALL ON public.recording_transcripts TO service_role;
GRANT ALL ON public.recording_transcript_cues TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.recording_transcript_cues_id_seq TO service_role;

ALTER TABLE public.recording_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recording_transcript_cues ENABLE ROW LEVEL SECURITY;

CREATE POLICY "signed-in users read transcripts" ON public.recording_transcripts
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "signed-in users read transcript cues" ON public.recording_transcript_cues
  FOR SELECT TO authenticated USING (true);