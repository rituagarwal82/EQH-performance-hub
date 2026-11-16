
CREATE TABLE public.buyer_classification (
  email_key text PRIMARY KEY,
  bucket text NOT NULL,
  decision text NOT NULL,
  note text,
  decided_by text NOT NULL DEFAULT 'owner',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.buyer_classification TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.buyer_classification TO authenticated;
GRANT ALL ON public.buyer_classification TO service_role;
ALTER TABLE public.buyer_classification ENABLE ROW LEVEL SECURITY;
CREATE POLICY "buyer_classification readable" ON public.buyer_classification FOR SELECT USING (true);
CREATE POLICY "buyer_classification service writes" ON public.buyer_classification FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE TRIGGER update_buyer_classification_updated_at BEFORE UPDATE ON public.buyer_classification
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.nolead_buyer_rows(p_since date, p_until date)
RETURNS TABLE (
  email_key text, email_raw text, payer_name text, first_date date, last_date date,
  sales integer, collected numeric, rows_count integer,
  bucket text, phone text, decision text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  with buyers as (
    select li.email_key,
           min(li.email_raw) as email_raw,
           min(li.payer_name) as payer_name,
           min(li.business_date) as first_date,
           max(li.business_date) as last_date,
           count(*) filter (where li.is_new_sale)::int as sales,
           sum(li.amount_received) as collected,
           count(*)::int as rows_count
      from ledger_inflow li
     where li.counts_as_sale
       and li.email_key is not null
       and li.business_date between p_since and p_until
     group by li.email_key
  ), nolead as (
    select b.* from buyers b
     where not exists (select 1 from leads l where l.email_key = b.email_key)
  ), ph as (
    select n.*,
      coalesce(
        (select norm_phone(t.buyer_phone) from tm_payments t
          where lower(t.buyer_email) = n.email_key and t.buyer_phone is not null limit 1),
        (select norm_phone(e.buyer_phone) from tm_enrolments e
          where lower(e.buyer_email) = n.email_key and e.buyer_phone is not null limit 1)
      ) as phone
    from nolead n
  ), c as (
    select ph.*, case when ph.phone is null then 0
                 else (select count(distinct l.email_key) from leads l where l.phone_key = ph.phone) end as cand
      from ph
  )
  select c.email_key, c.email_raw, c.payer_name, c.first_date, c.last_date,
         c.sales, c.collected, c.rows_count,
         case
           when c.phone is not null and c.cand = 1 then 'phone_match'
           when c.phone is not null and c.cand > 1 then 'phone_conflict'
           when c.first_date < coalesce((select min(business_date) from leads), '1900-01-01'::date) then 'predates_lead_history'
           else 'not_in_lead_system'
         end as bucket,
         c.phone,
         bc.decision
    from c
    left join buyer_classification bc on bc.email_key = c.email_key
   order by c.collected desc;
$$;
GRANT EXECUTE ON FUNCTION public.nolead_buyer_rows(date, date) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.nolead_buyer_summary(p_since date, p_until date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  select jsonb_build_object(
    'lead_history_start', (select min(business_date) from leads),
    'total', count(*),
    'sales', coalesce(sum(sales), 0),
    'collected', coalesce(sum(collected), 0),
    'buckets', coalesce(jsonb_object_agg(bucket, cnt) filter (where bucket is not null), '{}'::jsonb),
    'decided', count(*) filter (where decision is not null)
  )
  from (
    select bucket, decision, sales, collected, count(*) over (partition by bucket) as cnt
      from nolead_buyer_rows(p_since, p_until)
  ) s;
$$;
GRANT EXECUTE ON FUNCTION public.nolead_buyer_summary(date, date) TO anon, authenticated, service_role;
