-- The register is re-loaded whenever the team sends a newer sheet: rows are
-- upserted on person + entry date, so re-loading the same file changes nothing.
CREATE OR REPLACE FUNCTION public.load_team_register(p_rows jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE n bigint;
BEGIN
  INSERT INTO public.team_source_register
    (match_key, entry_date, student_name, email_raw, email_key, alt_email_raw, alt_email_key,
     phone10, team_source_raw, team_source_detail, webinar_attended, notes, loaded_at)
  SELECT DISTINCT ON (mk, entry_date) mk, entry_date, student_name, email, ek, alt_email, aek,
         p10, team_source, team_source_detail, webinar_attended, notes, now()
    FROM (
      SELECT (r->>'entry_date')::date AS entry_date,
             nullif(btrim(r->>'student_name'),'') AS student_name,
             nullif(btrim(r->>'email'),'') AS email,
             nullif(lower(btrim(r->>'email')),'') AS ek,
             nullif(btrim(r->>'alt_email'),'') AS alt_email,
             nullif(lower(btrim(r->>'alt_email')),'') AS aek,
             nullif(right(regexp_replace(coalesce(r->>'phone_10digit',''), '\D', '', 'g'), 10),'') AS p10,
             nullif(btrim(r->>'team_source'),'') AS team_source,
             nullif(btrim(r->>'team_source_detail'),'') AS team_source_detail,
             nullif(btrim(r->>'webinar_attended'),'') AS webinar_attended,
             nullif(btrim(r->>'notes'),'') AS notes
        FROM jsonb_array_elements(p_rows) AS r
    ) x
    CROSS JOIN LATERAL (
      SELECT coalesce(x.ek, 'phone:'||x.p10, 'name:'||lower(x.student_name)) AS mk
    ) m
   WHERE x.entry_date IS NOT NULL AND mk IS NOT NULL
   ORDER BY mk, entry_date, team_source
  ON CONFLICT (match_key, entry_date) DO UPDATE SET
    student_name = excluded.student_name, email_raw = excluded.email_raw,
    email_key = excluded.email_key, alt_email_raw = excluded.alt_email_raw,
    alt_email_key = excluded.alt_email_key, phone10 = excluded.phone10,
    team_source_raw = excluded.team_source_raw, team_source_detail = excluded.team_source_detail,
    webinar_attended = excluded.webinar_attended, notes = excluded.notes, loaded_at = now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

GRANT EXECUTE ON FUNCTION public.load_team_register(jsonb) TO service_role;