-- Run in Supabase SQL editor. Closes the QA-identified gaps in the Calendly
-- booking flow: the app never sent the CUSTOMER (invitee) a confirmation of
-- their own (only the client got notified), and no conversation-derived
-- meeting topic was ever generated or persisted.

-- ============================================================
-- leads: the dynamic topic is generated once, at the moment a reply is
-- classified BOOKING (see src/app/api/webhooks/mailgun/route.ts) — not at
-- signup, not at Calendly-connect time — and carried forward from there.
-- ============================================================
alter table leads add column if not exists meeting_topic text;

-- ============================================================
-- bookings: everything needed to answer "what is this appointment about,
-- who is it with, and did both sides actually get notified" without having
-- to re-derive it from Calendly or the conversation again.
-- ============================================================
alter table bookings add column if not exists invitee_name text;
alter table bookings add column if not exists invitee_timezone text;
alter table bookings add column if not exists meeting_location text;
alter table bookings add column if not exists cancel_url text;
alter table bookings add column if not exists reschedule_url text;
-- The Calendly Event Type's own name (e.g. "Discovery / Consultation Call")
-- — stays STATIC per event type, distinct from meeting_topic which is the
-- dynamic, conversation-derived subject.
alter table bookings add column if not exists event_name text;
alter table bookings add column if not exists meeting_topic text;

-- Notification delivery is tracked separately from booking validity: a
-- confirmation email failing to send must never un-confirm a real Calendly
-- booking (spec: "booking_status = confirmed, customer_notification_status =
-- failed", safely retryable).
alter table bookings add column if not exists customer_notification_status text not null default 'pending'
  check (customer_notification_status in ('pending', 'sent', 'failed', 'skipped'));
alter table bookings add column if not exists client_notification_status text not null default 'pending'
  check (client_notification_status in ('pending', 'sent', 'failed', 'skipped'));

-- ============================================================
-- clients: optional IANA timezone for the client's own notification email.
-- NULL is handled explicitly everywhere this is read (UTC is labelled, never
-- shown as a bare, ambiguous time) — this column just upgrades that display
-- to the client's real zone once they set one.
-- ============================================================
alter table clients add column if not exists timezone text;
