-- Daily snapshot of how far each feed's facts reach.
create or replace function public.snapshot_feed_edges()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into feed_edge_history (feed, observed_at, coverage_edge)
  select f.feed, date_trunc('day', now()),
         case f.feed
           when 'meta_ads' then (select max(d.date) from daily_metrics d where d.level = 'account')
           when 'zoom' then (select max(z.business_date) from zoom_sessions z)
           when 'ledger' then (select max(l.business_date) from ledger_inflow l)
           when 'tm_payments' then (select max(p.business_date) from tm_payments p)
           when 'tm_products' then (select max(pr.last_synced_at)::date from products pr)
           when 'leads' then (select max(le.business_date) from leads le)
           when 'proof' then (select max(rc.checked_at)::date from reconciliations rc)
         end
    from feed_config f
  on conflict (feed, observed_at) do update set coverage_edge = excluded.coverage_edge;
  get diagnostics n = row_count;
  return n;
end $$;

/**
 * THE INVARIANT PACK. Data-level locks, independent of whether a sync says it
 * succeeded. Every row lands in `reconciliations` like any other check.
 */
create or replace function public.run_invariants(p_start date, p_end date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  out_rows jsonb := '[]'::jsonb;
  d date;
  v_now timestamptz := now();
  v_a numeric; v_c numeric; v_bad_acc int; v_bad_camp int; v_bad_adset int;
  v_phantom int; v_leads_all int; v_leads_attr int;
  v_cash_all numeric; v_cash_paid numeric;
  v_sales int; v_enrol int;
  v_ledger_sales int; v_tm_rows int;
  v_i6_days int := 0;
  v_neg_spend int; v_neg_cash int; v_bad_rate int; v_worst_rate numeric;
  v_note text; v_verdict text;
begin
  perform public.snapshot_feed_edges();

  d := p_start;
  while d <= p_end loop
    ---------------------------------------------------------------- I1 grain
    select coalesce(sum(spend) filter (where level = 'account'), 0),
           coalesce(sum(spend) filter (where level = 'campaign'), 0)
      into v_a, v_c from daily_metrics where date = d;

    select count(*)::int into v_bad_acc from (
      select m.account_id,
             coalesce(sum(m.spend) filter (where m.level = 'account'), 0) a,
             coalesce(sum(m.spend) filter (where m.level = 'campaign'), 0) c
        from daily_metrics m where m.date = d group by m.account_id
    ) t where t.c > 0 and abs(t.a - t.c) > greatest(1, 0.01 * t.a);

    select count(*)::int into v_bad_camp from (
      select p.entity_id, p.spend a, coalesce(sum(ch.spend), 0) c
        from daily_metrics p
        left join ad_entities e on e.parent_id = p.entity_id and e.level = 'adset'
        left join daily_metrics ch on ch.entity_id = e.entity_id and ch.level = 'adset' and ch.date = d
       where p.date = d and p.level = 'campaign'
       group by p.entity_id, p.spend
    ) t where t.c > 0 and abs(t.a - t.c) > greatest(1, 0.01 * t.a);

    select count(*)::int into v_bad_adset from (
      select p.entity_id, p.spend a, coalesce(sum(ch.spend), 0) c
        from daily_metrics p
        left join ad_entities e on e.parent_id = p.entity_id and e.level = 'ad'
        left join daily_metrics ch on ch.entity_id = e.entity_id and ch.level = 'ad' and ch.date = d
       where p.date = d and p.level = 'adset'
       group by p.entity_id, p.spend
    ) t where t.c > 0 and abs(t.a - t.c) > greatest(1, 0.01 * t.a);

    if v_a > 0 or v_c > 0 then
      v_verdict := case when v_bad_acc + v_bad_camp + v_bad_adset = 0 then 'match' else 'diverged' end;
      out_rows := out_rows || jsonb_build_array(jsonb_build_object(
        'check_id','inv_grain_integrity','checked_at',v_now,'for_date',d,
        'primary_value', round(v_a,2), 'primary_source','Account-level spend as stored',
        'witness_value', round(v_c,2), 'witness_source','The same spend added up from the levels beneath it',
        'divergence_pct', case when v_a = 0 then 0 else round(100*(v_a-v_c)/v_a, 2) end,
        'verdict', v_verdict,
        'note', case when v_verdict = 'match'
          then 'Spend adds up at every level for this day, within a rupee or 1%.'
          else v_bad_acc || ' account(s), ' || v_bad_camp || ' campaign(s) and ' || v_bad_adset ||
               ' ad set(s) do not add up from the level beneath them.' end));
    end if;

    -------------------------------------------------------------- I1b phantom
    select count(*)::int into v_phantom
      from daily_metrics m
     where m.date = d and m.level <> 'account'
       and (m.entity_id is null
            or not exists (select 1 from ad_entities e
                            where e.entity_id = m.entity_id and e.level = m.level));

    out_rows := out_rows || jsonb_build_array(jsonb_build_object(
      'check_id','inv_no_phantom_rows','checked_at',v_now,'for_date',d,
      'primary_value', v_phantom, 'primary_source','Metric rows whose ad, ad set or campaign does not exist',
      'witness_value', 0, 'witness_source','Zero, always — this one has no tolerance',
      'divergence_pct', case when v_phantom = 0 then 0 else 100 end,
      'verdict', case when v_phantom = 0 then 'match' else 'diverged' end,
      'note', case when v_phantom = 0
        then 'Every metric row for this day belongs to a real ad, ad set or campaign.'
        else v_phantom || ' metric row(s) for this day belong to nothing we know about. This is how a spend figure invents itself.' end));

    ------------------------------------------------------- I3 paid <= total
    select count(*)::int, count(*) filter (where ad_entity_ref is not null)::int
      into v_leads_all, v_leads_attr from leads where business_date = d;

    select coalesce(sum(amount_received),0) into v_cash_all
      from ledger_inflow where business_date = d;
    select coalesce(sum(li.amount_received),0) into v_cash_paid
      from ledger_inflow li
     where li.business_date = d and li.is_new_sale
       and exists (select 1 from leads l where l.email_key = li.email_key and l.utm_source is not null);

    if v_leads_all > 0 or v_cash_all > 0 then
      v_verdict := case when v_leads_attr <= v_leads_all and v_cash_paid <= v_cash_all
                        then 'match' else 'diverged' end;
      out_rows := out_rows || jsonb_build_array(jsonb_build_object(
        'check_id','inv_paid_within_total','checked_at',v_now,'for_date',d,
        'primary_value', v_leads_attr, 'primary_source','Ad-attributed leads and ad-attributed cash',
        'witness_value', v_leads_all, 'witness_source','All leads and all cash for the day',
        'divergence_pct', case when v_leads_all = 0 then 0
                               else round(100.0*(v_leads_attr-v_leads_all)/v_leads_all, 2) end,
        'verdict', v_verdict,
        'note', case when v_verdict = 'match'
          then v_leads_attr || ' of ' || v_leads_all || ' leads and ' || round(v_cash_paid) ||
               ' of ' || round(v_cash_all) || ' rupees are ad-attributed — both inside the total, as they must be.'
          else 'A subset exceeds its total: the join is duplicating rows.' end));
    end if;

    -------------------------------------------------- I5 sales <= enrolments
    select count(*)::int into v_sales from tm_sales where business_date = d;
    select count(*)::int into v_enrol from tm_enrolments where business_date = d;
    if v_sales > 0 or v_enrol > 0 then
      out_rows := out_rows || jsonb_build_array(jsonb_build_object(
        'check_id','inv_sales_within_enrolments','checked_at',v_now,'for_date',d,
        'primary_value', v_sales, 'primary_source','Sales counted for the day',
        'witness_value', v_enrol, 'witness_source','Enrolments recorded for the day',
        'divergence_pct', case when v_enrol = 0 then 100 else round(100.0*(v_sales-v_enrol)/v_enrol, 2) end,
        'verdict', case when v_sales <= v_enrol then 'match' else 'diverged' end,
        'note', case when v_sales <= v_enrol
          then v_sales || ' sales sit inside ' || v_enrol || ' enrolments.'
          else v_sales || ' sales against only ' || v_enrol || ' enrolments — a sale exists that nobody enrolled in.' end));
    end if;

    -------------------------------- I6 ledger says sales, TagMango is silent
    select count(*)::int into v_ledger_sales
      from ledger_inflow where business_date = d and is_new_sale;
    select count(*)::int into v_tm_rows
      from tm_payments p left join products pr on pr.mango_id = p.mango_id
     where p.business_date = d and coalesce(pr.counts_as_sale, false);

    if v_ledger_sales > 0 then
      v_verdict := case when v_tm_rows > 0 then 'match' else 'diverged' end;
      if v_verdict = 'diverged' then v_i6_days := v_i6_days + 1; end if;
      out_rows := out_rows || jsonb_build_array(jsonb_build_object(
        'check_id','inv_ledger_vs_tagmango_silence','checked_at',v_now,'for_date',d,
        'primary_value', v_ledger_sales, 'primary_source','New sales in the accounts ledger',
        'witness_value', v_tm_rows, 'witness_source','TagMango payments on sale-counting products',
        'divergence_pct', case when v_ledger_sales = 0 then 0 else round(100.0*(v_tm_rows-v_ledger_sales)/v_ledger_sales,2) end,
        'verdict', v_verdict,
        'note', case when v_verdict = 'match'
          then v_ledger_sales || ' ledger sales with ' || v_tm_rows || ' TagMango payments behind them.'
          else 'The ledger recorded ' || v_ledger_sales || ' sales and TagMango sent nothing at all. The payments feed is not fetching, whatever it reports.' end));
    end if;

    --------------------------------------------------------- I10 rate sanity
    select count(*)::int into v_neg_spend from daily_metrics where date = d and spend < 0;
    select count(*)::int into v_neg_cash from ledger_inflow where business_date = d and amount_received < 0;
    select count(*)::int, max(round(100.0*z.total_attendees/nullif(z.total_registrants,0), 1))
      into v_bad_rate, v_worst_rate
      from zoom_sessions z
     where z.business_date = d and coalesce(z.total_registrants,0) > 0
       and z.total_attendees > z.total_registrants;

    if v_neg_spend + v_neg_cash + v_bad_rate > 0
       or exists (select 1 from daily_metrics where date = d)
       or exists (select 1 from zoom_sessions where business_date = d) then
      v_verdict := case when v_neg_spend + v_neg_cash + v_bad_rate = 0 then 'match' else 'diverged' end;
      out_rows := out_rows || jsonb_build_array(jsonb_build_object(
        'check_id','inv_rate_sanity','checked_at',v_now,'for_date',d,
        'primary_value', v_neg_spend + v_neg_cash + v_bad_rate,
        'primary_source','Impossible values found in the day''s data',
        'witness_value', 0, 'witness_source','Zero, always',
        'divergence_pct', case when v_neg_spend + v_neg_cash + v_bad_rate = 0 then 0 else 100 end,
        'verdict', v_verdict,
        'note', case when v_verdict = 'match'
          then 'No negative money and no attendance above 100% in this day''s data.'
          else v_neg_spend || ' negative spend row(s), ' || v_neg_cash || ' negative collection row(s), ' ||
               v_bad_rate || ' session(s) with more attendees than registrants' ||
               coalesce(' (worst ' || v_worst_rate || '%)', '') || '.' end));
    end if;

    d := d + 1;
  end loop;

  ------------------------------------------------- I7 coverage monotonicity
  declare
    v_back text[]; v_feeds int;
  begin
    select count(*)::int into v_feeds from feed_config;
    select array_agg(t.feed || ': reached ' || t.best || ', now only ' || t.nowedge order by t.feed)
      into v_back
      from (
        select h.feed, max(h.coverage_edge) best,
               (select h2.coverage_edge from feed_edge_history h2
                 where h2.feed = h.feed order by h2.observed_at desc limit 1) nowedge
          from feed_edge_history h group by h.feed
      ) t
     where t.nowedge is not null and t.best is not null and t.nowedge < t.best;

    out_rows := out_rows || jsonb_build_array(jsonb_build_object(
      'check_id','inv_coverage_monotonic','checked_at',v_now,'for_date',current_date,
      'primary_value', v_feeds - coalesce(array_length(v_back,1),0),
      'primary_source','Feeds whose data still reaches as far as it ever did',
      'witness_value', v_feeds, 'witness_source','All feeds',
      'divergence_pct', case when v_feeds = 0 then 0
                             else round(-100.0*coalesce(array_length(v_back,1),0)/v_feeds, 2) end,
      'verdict', case when coalesce(array_length(v_back,1),0) = 0 then 'match' else 'diverged' end,
      'note', case when coalesce(array_length(v_back,1),0) = 0
        then 'No feed has gone backwards: every one still covers at least as far as its best day.'
        else 'Coverage has gone backwards — rows were deleted or the source was re-pointed: ' ||
             array_to_string(v_back, ' · ') end));
  end;

  -- I6 second lock: force the TagMango feed stale at the data level.
  if v_i6_days > 0 then
    update feed_config
       set forced_stale_reason = 'The ledger recorded sales on ' || v_i6_days ||
             ' day(s) in the last fortnight with no TagMango payments at all.',
           forced_stale_at = v_now
     where feed = 'tm_payments';
  else
    update feed_config set forced_stale_reason = null, forced_stale_at = null
     where feed = 'tm_payments' and forced_stale_reason is not null;
  end if;

  return out_rows;
end $$;

revoke execute on function public.run_invariants(date, date) from public;
revoke execute on function public.snapshot_feed_edges() from public;
grant execute on function public.run_invariants(date, date) to service_role;
grant execute on function public.snapshot_feed_edges() to service_role;