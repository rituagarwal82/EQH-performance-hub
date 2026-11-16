ALTER TABLE public.daily_metrics
  ADD CONSTRAINT daily_metrics_entity_required
  CHECK (level = 'account' OR entity_id IS NOT NULL);