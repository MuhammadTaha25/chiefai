-- Run in Supabase SQL editor.
-- CRITICAL-01 (QA report, Oct 2026): src/app/api/webhooks/mailgun/route.ts reads
-- and writes this table on every inbound reply, but no migration ever created
-- it, so every inbound request was returning 500 wherever it hadn't been
-- created by hand. Dedup claim: the INSERT is the lock (message_id UNIQUE) —
-- of several concurrent deliveries of the same message, exactly one wins.

create table if not exists processed_inbound_messages (
  message_id text primary key,
  thread_key text,
  processed_at timestamptz not null default now()
);
create index if not exists processed_inbound_messages_thread_key_idx on processed_inbound_messages (thread_key);

alter table processed_inbound_messages enable row level security;
-- Service-role only: the webhook uses createAdminClient(), and no client UI
-- ever needs to read this table directly, so no select policy is added.
