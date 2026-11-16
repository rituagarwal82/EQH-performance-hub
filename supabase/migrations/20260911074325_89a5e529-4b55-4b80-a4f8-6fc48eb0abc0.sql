CREATE TABLE IF NOT EXISTS public.source_dictionary (
  id uuid primary key default gen_random_uuid(),
  raw_value text not null,
  layer text not null check (layer in ('utm','ghl_source','tag','pabbly_cf')),
  match_kind text not null default 'exact' check (match_kind in ('exact','prefix')),
  channel_group text not null,
  display_name text not null,
  is_acquisition boolean not null default true,
  is_paid boolean not null default false,
  valid_from date,
  valid_to date,
  confidence text not null default 'confirmed' check (confidence in ('confirmed','inferred','unknown')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

CREATE UNIQUE INDEX IF NOT EXISTS source_dictionary_key_idx
  ON public.source_dictionary (lower(raw_value), layer, coalesce(valid_from, '1900-01-01'::date));

GRANT ALL ON public.source_dictionary TO service_role;
ALTER TABLE public.source_dictionary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service role manages source dictionary"
  ON public.source_dictionary FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.source_dictionary_touch() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS source_dictionary_touch_trg ON public.source_dictionary;
CREATE TRIGGER source_dictionary_touch_trg BEFORE UPDATE ON public.source_dictionary
  FOR EACH ROW EXECUTE FUNCTION public.source_dictionary_touch();

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS unified_source text,
  ADD COLUMN IF NOT EXISTS unified_channel text,
  ADD COLUMN IF NOT EXISTS unified_confidence text,
  ADD COLUMN IF NOT EXISTS resolution_layer text;

CREATE OR REPLACE FUNCTION public.dict_match(p_value text, p_layer text, p_on date)
RETURNS TABLE (display_name text, channel_group text, is_paid boolean, confidence text, is_acquisition boolean)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT d.display_name, d.channel_group, d.is_paid, d.confidence, d.is_acquisition
  FROM public.source_dictionary d
  WHERE d.layer = p_layer
    AND nullif(btrim(p_value),'') IS NOT NULL
    AND ( (d.match_kind = 'exact'  AND lower(btrim(p_value)) = lower(d.raw_value))
       OR (d.match_kind = 'prefix' AND lower(btrim(p_value)) LIKE lower(d.raw_value) || '%') )
    AND (d.valid_from IS NULL OR coalesce(p_on, current_date) >= d.valid_from)
    AND (d.valid_to   IS NULL OR coalesce(p_on, current_date) <= d.valid_to)
  ORDER BY (d.match_kind = 'exact') DESC, length(d.raw_value) DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.dict_match(text,text,date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dict_match(text,text,date) TO service_role;
