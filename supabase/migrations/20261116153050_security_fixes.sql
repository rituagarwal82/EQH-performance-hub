-- Security fixes, 16 Nov 2026 (EQH Performance Hub). Idempotent: safe to re-run.
--
-- 1. owner_emails: the owner allow-list checked by the server-function gate.
-- 2. app_settings: signed-in users can no longer UPDATE it directly.
-- 3. cron_post(): sends a dedicated secret (Vault: cron_secret) as x-cron-secret.
-- 4. SECURITY DEFINER functions: no EXECUTE for PUBLIC / anon / authenticated.

-- ---------------------------------------------------------------------------
-- 1. Owner allow-list (data, not code). Read only by the server (service role).
--    Seeded with the owner report recipients already used in code:
--    daily-email.server.ts PRIMARY + COPY, agency-email.server.ts OWNER_CC.
-- ---------------------------------------------------------------------------
create table if not exists public.owner_emails (
  email      text primary key check (email = lower(btrim(email)) and email <> ''),
  note       text,
  added_at   timestamptz not null default now()
);
alter table public.owner_emails enable row level security;
revoke all on table public.owner_emails from public, anon, authenticated;
grant select, insert, update, delete on table public.owner_emails to service_role;

insert into public.owner_emails (email, note) values
  ('rituagarwal82@gmail.com', 'owner report recipient (daily-email PRIMARY, agency OWNER_CC)'),
  ('connect@energyqueenshub.com', 'owner report copy (daily-email COPY)')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------------
-- 2. app_settings: drop the "any signed-in user may edit" policy.
--    Every app write to app_settings goes through server code with the
--    service-role key (dashboard.functions.ts, zoom.functions.ts, the sync
--    jobs), which keeps its own policy. The browser never writes it.
--    Closes: flipping open_access, and re-pointing cron_base_url so the job
--    secret would be sent to someone else's server.
-- ---------------------------------------------------------------------------
drop policy if exists "Authenticated can edit app_settings" on public.app_settings;

-- ---------------------------------------------------------------------------
-- 3. Scheduled-job secret. Created once in Vault (value never in code).
--    cron_post() now also sends it as x-cron-secret. The apikey header stays
--    for the transition; the server stops accepting it once the env var
--    CRON_SECRET is set to the same value.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'cron_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'cron_secret',
      'Shared secret pg_cron sends to /api/public/* as x-cron-secret. Must equal the CRON_SECRET app secret.'
    );
  end if;
end $$;

create or replace function public.cron_post(p_jobname text)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare m record; v_base text; v_key text; v_secret text; v_url text; v_id bigint; v_headers jsonb;
begin
  select * into m from public.cron_manifest where jobname = p_jobname;
  if not found then raise exception 'no manifest row for %', p_jobname; end if;
  select value into v_base from public.app_settings where key = 'cron_base_url';
  select value into v_key  from public.app_settings where key = 'cron_api_key';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  if v_base is null or (v_key is null and v_secret is null) then
    raise exception 'cron_base_url, or both cron_api_key and the cron_secret vault secret, missing';
  end if;
  v_url := v_base || m.url_path;
  v_headers := jsonb_build_object('Content-Type', 'application/json');
  if v_key is not null then v_headers := v_headers || jsonb_build_object('apikey', v_key); end if;
  if v_secret is not null then v_headers := v_headers || jsonb_build_object('x-cron-secret', v_secret); end if;
  select net.http_post(
    url := v_url,
    body := m.body,
    headers := v_headers,
    timeout_milliseconds := m.timeout_ms) into v_id;
  insert into public.cron_http_calls (request_id, jobname, url)
  values (v_id, p_jobname, v_url)
  on conflict (request_id) do nothing;
  return v_id;
end
$function$;
revoke all on function public.cron_post(text) from public, anon, authenticated;
grant execute on function public.cron_post(text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. SECURITY DEFINER functions in public: remove EXECUTE from PUBLIC, anon
--    and authenticated. Callers checked 16 Nov:
--      * the app calls RPCs only from server code with the service-role key
--        (pg.server.ts pgRpc, client.server.ts) - the browser never calls .rpc;
--      * pg_cron jobs run as postgres (owner);
--      * the Ask feature runs SQL as eqh_ask_ro, and the Supabase read-only
--        user reads as supabase_read_only_user - both keep exactly the access
--        they had (re-granted explicitly where it came only via PUBLIC);
--      * no RLS policy calls any of these functions.
--    Trigger functions and functions not owned by postgres are skipped.
-- ---------------------------------------------------------------------------
do $$
declare
  f record;
  keep_role text;
  had boolean;
begin
  for f in
    select p.oid, format('public.%I(%s)', p.proname, pg_catalog.oidvectortypes(p.proargtypes)) as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.prosecdef
      and p.prorettype <> 'trigger'::regtype
      and pg_get_userbyid(p.proowner) = 'postgres'
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    -- Preserve the internal read-only roles' current access before PUBLIC goes.
    foreach keep_role in array array['eqh_ask_ro', 'supabase_read_only_user'] loop
      if exists (select 1 from pg_roles where rolname = keep_role) then
        had := has_function_privilege(keep_role, f.oid, 'execute');
        if had then
          execute format('grant execute on function %s to %I', f.sig, keep_role);
        end if;
      end if;
    end loop;
    execute format('grant execute on function %s to service_role', f.sig);
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
