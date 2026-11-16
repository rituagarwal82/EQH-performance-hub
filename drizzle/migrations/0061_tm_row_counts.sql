CREATE OR REPLACE FUNCTION public.tm_row_counts()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object('payments', (SELECT count(*) FROM public.tm_payments),
                            'enrolments', (SELECT count(*) FROM public.tm_enrolments));
$$;
REVOKE ALL ON FUNCTION public.tm_row_counts() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.tm_row_counts() TO service_role, authenticated;