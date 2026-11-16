alter table public.creative_scripts alter column script_text drop not null;

create or replace function public.upsert_creative_scripts(p_rows jsonb, p_source text default 'doc_seed')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  with upserted as (
    insert into public.creative_scripts (script_code, title, script_text, first_8s_hook, source, language)
    select
      btrim(r->>'script_code'),
      nullif(btrim(coalesce(r->>'title','')), ''),
      nullif(btrim(coalesce(r->>'script_text','')), ''),
      nullif(btrim(coalesce(r->>'first_8s_hook','')), ''),
      coalesce(nullif(r->>'source',''), p_source),
      coalesce(nullif(r->>'language',''), 'en')
    from jsonb_array_elements(p_rows) as r
    where nullif(btrim(coalesce(r->>'script_code','')), '') is not null
    on conflict (script_code) do update set
      title = coalesce(excluded.title, public.creative_scripts.title),
      script_text = coalesce(excluded.script_text, public.creative_scripts.script_text),
      first_8s_hook = coalesce(excluded.first_8s_hook, public.creative_scripts.first_8s_hook),
      source = excluded.source,
      language = excluded.language,
      updated_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;
  return v_count;
end;
$$;

revoke all on function public.upsert_creative_scripts(jsonb, text) from public;
grant execute on function public.upsert_creative_scripts(jsonb, text) to service_role;