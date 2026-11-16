
ALTER TABLE public.ledger_inflow_backup_20260907 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ledger_inflow_backup_20260907 FROM anon, authenticated;
GRANT ALL ON public.ledger_inflow_backup_20260907 TO service_role;
