insert into public.app_settings (key, value, description) values
  ('webinar_off_days', '2026-08-15,2026-08-28',
   'Comma-separated business dates (YYYY-MM-DD) on which no webinar was scheduled. These days render as "no webinar scheduled" rather than a missed-session warning.')
on conflict (key) do update set description = excluded.description;