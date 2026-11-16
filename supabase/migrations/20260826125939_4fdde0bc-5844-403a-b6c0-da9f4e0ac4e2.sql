revoke execute on function public.zoom_session_rows(date, date) from anon, authenticated;
revoke execute on function public.zoom_retention_curve(text) from anon, authenticated;
revoke execute on function public.upsert_zoom_sessions(jsonb) from anon, authenticated;
revoke execute on function public.upsert_zoom_participants(jsonb) from anon, authenticated;