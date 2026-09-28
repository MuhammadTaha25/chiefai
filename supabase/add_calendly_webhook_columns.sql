-- Run in Supabase SQL editor. Needed for the Calendly booking webhook
-- (spec PHASE 9) — each client's own webhook subscription gets its own
-- signing key from Calendly, used to verify that an incoming webhook really
-- came from Calendly for THIS client (not guessed, not another client's).
alter table clients add column if not exists calendly_webhook_uri text;
alter table clients add column if not exists calendly_webhook_signing_key text;
