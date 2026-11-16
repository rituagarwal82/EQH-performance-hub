ALTER TABLE public.agency_spend_status
  ADD COLUMN IF NOT EXISTS ratios_valid_from date;

COMMENT ON COLUMN public.agency_spend_status.ratios_valid_from IS
  'Earliest business date from which per-team money ratios are honest for this team: the point at which its spend runs in ad accounts of its own and its leads trace to those ads. NULL = never valid. Ratios must be refused for any selected range starting before this date, even when ratios_computable is true.';

UPDATE public.agency_spend_status SET ratios_valid_from = DATE '2026-08-01' WHERE agency_code = 'SD';
UPDATE public.agency_spend_status SET ratios_valid_from = DATE '2026-09-01' WHERE agency_code = 'RJ';
UPDATE public.agency_spend_status SET ratios_valid_from = NULL WHERE agency_code = 'PRM';