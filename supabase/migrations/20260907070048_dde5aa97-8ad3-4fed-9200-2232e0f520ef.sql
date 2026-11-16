-- The per-person lead view sorts 240k rows by email each time it is read.
-- Since the full CRM import that sort stopped fitting inside the query time
-- limit, which is what made Today refuse to render. This index lets the sort
-- be skipped entirely.
CREATE INDEX IF NOT EXISTS leads_email_captured_idx
  ON public.leads (email_key, captured_at)
  WHERE email_key IS NOT NULL AND email_key <> '';

-- Three separate copies of the same single-column email index existed.
DROP INDEX IF EXISTS public.leads_email_idx;
DROP INDEX IF EXISTS public.leads_captured_idx;

ANALYZE public.leads;