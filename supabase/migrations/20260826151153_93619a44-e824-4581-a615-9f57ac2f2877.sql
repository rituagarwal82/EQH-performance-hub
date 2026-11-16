ALTER TABLE public.zoom_sessions ALTER COLUMN participants_status DROP DEFAULT;

ALTER TABLE public.zoom_sessions
  DROP CONSTRAINT IF EXISTS zoom_sessions_participants_status_check;

ALTER TABLE public.zoom_sessions
  ADD CONSTRAINT zoom_sessions_participants_status_check
  CHECK (participants_status IS NULL
         OR participants_status IN ('fetched','empty','failed','unavailable'));

ALTER TABLE public.zoom_sessions
  DROP CONSTRAINT IF EXISTS zoom_sessions_session_role_check;

ALTER TABLE public.zoom_sessions
  ADD CONSTRAINT zoom_sessions_session_role_check
  CHECK (session_role IS NULL
         OR session_role IN ('live','replay','test','unknown'));