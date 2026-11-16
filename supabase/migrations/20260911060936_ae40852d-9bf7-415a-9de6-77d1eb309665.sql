CREATE OR REPLACE FUNCTION public.inv_view_security_invoker_rows()
 RETURNS TABLE(check_id text, checked_at timestamp with time zone, for_date date, primary_value numeric, primary_source text, witness_value numeric, witness_source text, divergence_pct numeric, verdict text, note text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH bad AS (
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'v'
       AND NOT coalesce((
         SELECT lower(option_value) IN ('true','on','yes','1')
         FROM pg_options_to_table(c.reloptions)
         WHERE option_name = 'security_invoker'
       ), false)
  )
  SELECT 'inv_view_security_invoker'::text, now(), current_date,
         0::numeric, 'view definition'::text,
         1::numeric, 'required setting'::text,
         NULL::numeric, 'diverged'::text,
         format('View %I runs with owner privileges, so row-level permissions do not apply to it. Set security_invoker on.', b.relname)
    FROM bad b
  UNION ALL
  -- A clean result must still be recorded, or an unrun check and a passing
  -- check look identical on screen.
  SELECT 'inv_view_security_invoker'::text, now(), current_date,
         0::numeric, 'view definition'::text,
         0::numeric, 'required setting'::text,
         0::numeric, 'match'::text,
         'Every view respects row-level permissions.'::text
   WHERE NOT EXISTS (SELECT 1 FROM bad);
$function$;