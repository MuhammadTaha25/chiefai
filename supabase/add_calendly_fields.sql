-- Run in Supabase SQL editor. Adds Calendly scheduling link storage per
-- client, and a uniqueness guard on calendly_event_id so the webhook can't
-- double-process the same booking event (idempotency).

alter table clients add column if not exists calendly_url text;

create unique index if not exists appointments_calendly_event_id_key
  on appointments (calendly_event_id)
  where calendly_event_id is not null;
