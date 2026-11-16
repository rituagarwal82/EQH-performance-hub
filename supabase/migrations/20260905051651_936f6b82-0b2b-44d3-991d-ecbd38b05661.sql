create or replace function public.norm_ad_name(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select nullif(lower(regexp_replace(btrim(coalesce(p,'')), '\s+', ' ', 'g')), '') $$;