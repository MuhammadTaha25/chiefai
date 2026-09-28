-- Run in Supabase SQL editor (project timfpxablcdgwrkucrjj).
-- Extends social_reply_log (see supabase/add_social_reply_dedup_log.sql) to
-- support the real Instagram/Facebook DM+comment AI-reply pipeline:
-- - external_id now holds the Zernio webhook event id ("id" field on the
--   message.received / comment.received payload), which is stable across
--   Zernio's own redelivery retries — the actual idempotency key.
-- - status/needs_handoff/error_message let the workflow record what happened
--   even when no reply was sent (handoff, unmapped account, send failure),
--   so every inbound event is auditable, not just successful sends.

alter table social_reply_log add column if not exists status text
  not null default 'sent'
  check (status in ('sent', 'handoff', 'ignored_unmapped', 'ignored_incomplete_profile', 'send_failed', 'private_reply_unavailable'));

alter table social_reply_log add column if not exists needs_handoff boolean not null default false;
alter table social_reply_log add column if not exists error_message text;
alter table social_reply_log add column if not exists sender_platform_id text;

-- external_id was populated with Meta's raw ids under the old (unbuilt) design;
-- going forward the n8n workflow keys it on Zernio's own webhook event id.
comment on column social_reply_log.external_id is
  'Zernio webhook event id (payload.id on message.received / comment.received) — stable across Zernio''s own redelivery retries.';
