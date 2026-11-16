-- A lead whose ad we cannot see (no ad entity, or an account with no team yet)
-- has no ownership answer to compare against. Silence is not disagreement:
-- only count a mismatch where both sides actually name a team.
CREATE OR REPLACE FUNCTION public.inv_basis_symmetry_rows(p_start date, p_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := now();
  out_rows jsonb := '[]'::jsonb;
  r record;
  v_id text;
BEGIN
  FOR r IN
    WITH scope AS (
      SELECT l.lead_id,
             public.channel_team_code(u.unified_channel) AS stored,
             CASE WHEN e.entity_id IS NOT NULL THEN a.agency_code
                  ELSE public.agency_code_for(l.utm_source) END AS owned
        FROM public.leads l
        LEFT JOIN public.lead_unified_source u ON u.lead_id = l.lead_id
        LEFT JOIN public.ad_entities e ON e.entity_id = l.ad_entity_ref
        LEFT JOIN public.ad_accounts a ON a.account_id = e.account_id
       WHERE l.business_date BETWEEN p_start AND p_end
    )
    SELECT coalesce(s.stored, s.owned) AS team,
           count(*)::bigint AS n,
           count(*) FILTER (WHERE s.stored IS NOT NULL AND s.owned IS NOT NULL
                              AND s.stored IS DISTINCT FROM s.owned)::bigint AS mismatched
      FROM scope s
     WHERE coalesce(s.stored, s.owned) IS NOT NULL
     GROUP BY 1
  LOOP
    v_id := CASE WHEN r.team IN ('SD','RJ','SX','PRM')
                 THEN 'inv_basis_symmetry_' || lower(r.team)
                 ELSE 'inv_basis_symmetry' END;
    out_rows := out_rows || jsonb_build_array(jsonb_build_object(
      'check_id', v_id, 'checked_at',v_now,'for_date',p_end,
      'primary_value', r.n - r.mismatched,
      'primary_source','Leads for team ' || r.team || ' whose team comes from the ad account that team owns',
      'witness_value', r.n,
      'witness_source','All leads counted against team ' || r.team,
      'divergence_pct', CASE WHEN r.n = 0 THEN 0 ELSE round(100.0 * r.mismatched / r.n, 2) END,
      'verdict', CASE WHEN r.mismatched = 0 THEN 'match' ELSE 'diverged' END,
      'note', CASE WHEN r.mismatched = 0
        THEN r.team || ': spend and cash both decide team membership by who owns the ad account. Same definition on both sides.'
        ELSE r.team || ': ' || r.mismatched || ' of ' || r.n ||
             ' leads are counted against a team that does not own the ad they came from. ' ||
             'Spend and cash are describing different populations — every ratio for this team is wrong until it is re-derived.' END));
  END LOOP;

  IF out_rows = '[]'::jsonb THEN
    out_rows := jsonb_build_array(jsonb_build_object(
      'check_id','inv_basis_symmetry','checked_at',v_now,'for_date',p_end,
      'primary_value', 0, 'primary_source','Leads carrying a team in this window',
      'witness_value', 0, 'witness_source','None to check',
      'divergence_pct', 0, 'verdict','match',
      'note','No lead in this window carries a team, so there is nothing that could disagree.'));
  END IF;

  RETURN out_rows;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.inv_basis_symmetry_rows(date, date) TO authenticated, service_role;