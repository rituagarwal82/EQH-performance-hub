ALTER TABLE public.webinar_transcripts
  ADD COLUMN IF NOT EXISTS actual_start_offset_ms integer,
  ADD COLUMN IF NOT EXISTS actual_start_evidence text;

ALTER TABLE public.script_markers
  ADD COLUMN IF NOT EXISTS at_webinar_ms integer;

COMMENT ON COLUMN public.script_markers.at_ms IS 'Offset from recording start (includes pre-start promo window).';
COMMENT ON COLUMN public.script_markers.at_webinar_ms IS 'Offset from the promised slot start / presenter going live. This is the canonical anchor for all minute-based analytics.';