CREATE OR REPLACE FUNCTION public.inv_spend_symmetry_rows(p_start date, p_end date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
declare
  v_x numeric; v_xr bigint; v_teams text[]; v_now timestamptz := now();
begin
  select excluded_cash, excluded_rows, teams into v_x, v_xr, v_teams
    from public.spend_symmetry(p_start, p_end);
  return jsonb_build_array(jsonb_build_object(
    'check_id','inv_spend_symmetry','checked_at',v_now,'for_date',p_end,
    'primary_value', round(coalesce(v_x,0),2),
    'primary_source','Paid-ratio cash from teams whose ad spend is not connected',
    'witness_value', 0, 'witness_source','What that figure must be',
    'divergence_pct', case when coalesce(v_x,0) = 0 then 0 else 100 end,
    'verdict', case when coalesce(v_x,0) = 0 then 'match' else 'diverged' end,
    'note', case when coalesce(v_x,0) = 0
      then 'Every rupee inside the paid ratios comes from a team whose ad spend reaches us.'
      else round(v_x) || ' of collections across ' || v_xr || ' sale(s) came from ' ||
           array_to_string(v_teams, ', ') ||
           ' — whose ad spend is not connected. It is held out of the paid ratios and shown separately.' end));
end $$;

REVOKE ALL ON FUNCTION public.inv_spend_symmetry_rows(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inv_spend_symmetry_rows(date, date) TO service_role;