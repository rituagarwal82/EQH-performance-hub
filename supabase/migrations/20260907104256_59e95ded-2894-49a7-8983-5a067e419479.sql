-- O1(b): the 40-minute snap window fails for 52 sessions in Mar-May because the
-- schedule itself changed. Slot times are therefore effective-dated. The newest
-- row always defers to app_settings.webinar_slot_times_ist so the owner-facing
-- setting stays the single control for today's schedule.
CREATE TABLE IF NOT EXISTS public.webinar_slot_schedule (
  effective_from date PRIMARY KEY,
  slots text NOT NULL,
  confirmed_by text NOT NULL,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.webinar_slot_schedule TO authenticated;
GRANT ALL ON public.webinar_slot_schedule TO service_role;
ALTER TABLE public.webinar_slot_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY "slot schedule readable by signed-in users"
  ON public.webinar_slot_schedule FOR SELECT TO authenticated USING (true);
CREATE POLICY "slot schedule managed by service role"
  ON public.webinar_slot_schedule FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.webinar_slot_schedule (effective_from, slots, confirmed_by, note) VALUES
  ('2000-01-01','11:00,15:00,20:00','observed',
   'Derived from room-open clustering before the schedule change (10:30-10:45, 14:30-14:45, 19:30-19:45). Not owner-confirmed.'),
  ('2026-05-25','15:00,19:00','owner',
   'Owner-confirmed promised start times. Rooms open 15-25 minutes early with promo videos, which is not webinar time.')
ON CONFLICT (effective_from) DO NOTHING;

CREATE OR REPLACE FUNCTION public.session_t0(p_start timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with sched as (
    select s.slots, s.effective_from,
           (s.effective_from = (select max(effective_from) from public.webinar_slot_schedule)) as is_current
      from public.webinar_slot_schedule s
     where s.effective_from <= (p_start at time zone 'Asia/Kolkata')::date
     order by s.effective_from desc
     limit 1
  ), src as (
    select case when (select is_current from sched)
                then coalesce((select value from public.app_settings where key = 'webinar_slot_times_ist'),
                              (select slots from sched))
                else coalesce((select slots from sched), '15:00,19:00') end as slots
  ), slots as (
    select trim(x) as hhmm
      from unnest(string_to_array(coalesce((select slots from src), '15:00,19:00'), ',')) as x
  ), cand as (
    select (((p_start at time zone 'Asia/Kolkata')::date + s.hhmm::time) at time zone 'Asia/Kolkata') as t0
      from slots s
  )
  select coalesce(
    (select c.t0 from cand c
      where abs(extract(epoch from (c.t0 - p_start))) <= 2400
      order by abs(extract(epoch from (c.t0 - p_start)))
      limit 1),
    p_start);
$function$;