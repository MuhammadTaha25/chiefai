-- Run in Supabase SQL editor. Caps the Calendly booking-notification retry
-- sweep (src/app/api/cron/calendly-sync/route.ts) at a maximum attempt count
-- instead of retrying a permanently-undeliverable email forever.

alter table bookings add column if not exists customer_notification_attempts integer not null default 0;
alter table bookings add column if not exists client_notification_attempts integer not null default 0;

-- 'permanently_failed' is a terminal state: the retry sweep stops picking the
-- row up once the attempt cap is reached, but the booking row itself is
-- untouched — a permanently failed notification never invalidates a real
-- booking.
alter table bookings drop constraint if exists bookings_customer_notification_status_check;
alter table bookings add constraint bookings_customer_notification_status_check
  check (customer_notification_status in ('pending', 'sent', 'failed', 'permanently_failed', 'skipped'));

alter table bookings drop constraint if exists bookings_client_notification_status_check;
alter table bookings add constraint bookings_client_notification_status_check
  check (client_notification_status in ('pending', 'sent', 'failed', 'permanently_failed', 'skipped'));
