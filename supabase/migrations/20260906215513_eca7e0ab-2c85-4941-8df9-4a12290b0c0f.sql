
CREATE TABLE IF NOT EXISTS public.metric_orphan_notes (
  entity_id text PRIMARY KEY,
  reason text NOT NULL,
  noted_by text NOT NULL DEFAULT 'owner',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.metric_orphan_notes TO authenticated;
GRANT ALL ON public.metric_orphan_notes TO service_role;

ALTER TABLE public.metric_orphan_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users can read orphan notes"
  ON public.metric_orphan_notes FOR SELECT TO authenticated USING (true);

CREATE TRIGGER update_metric_orphan_notes_updated_at
  BEFORE UPDATE ON public.metric_orphan_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.inv_orphan_history_rows()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
declare v_orphans int; v_annotated int; v_spend numeric; v_span text;
begin
  select count(*)::int,
         coalesce(round(sum(m.spend),2),0),
         coalesce(min(m.date)::text || ' to ' || max(m.date)::text, '')
    into v_orphans, v_spend, v_span
    from daily_metrics m
   where m.entity_id is not null
     and not exists (select 1 from ad_entities e where e.entity_id = m.entity_id)
     and not exists (select 1 from metric_orphan_notes n where n.entity_id = m.entity_id);

  select count(*)::int into v_annotated
    from daily_metrics m
    join metric_orphan_notes n on n.entity_id = m.entity_id
   where not exists (select 1 from ad_entities e where e.entity_id = m.entity_id);

  return jsonb_build_array(jsonb_build_object(
    'check_id','inv_orphan_history',
    'checked_at', now(),
    'for_date', current_date,
    'primary_value', (select count(*) from daily_metrics where entity_id is not null),
    'primary_source','Every spend row we hold, all history',
    'witness_value', (select count(*) from daily_metrics where entity_id is not null) - v_orphans,
    'witness_source','Rows whose ad, ad set or campaign is in the registry or explained',
    'divergence_pct', case when v_orphans = 0 then 0 else 100 end,
    'verdict', case when v_orphans = 0 then 'match' else 'diverged' end,
    'note', case when v_orphans = 0
      then 'Every spend row in the whole history belongs to something we know about'
           || case when v_annotated > 0 then ', including ' || v_annotated || ' row(s) whose ad was deleted at Meta and is recorded as such.' else '.' end
      else v_orphans || ' spend row(s) (' || v_spend || ', ' || v_span ||
           ') belong to nothing we know about. Fetch the ad from Meta, or record why it is gone.' end
  ));
end $fn$;
