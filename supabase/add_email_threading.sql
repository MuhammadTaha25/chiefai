-- Run in Supabase SQL editor.
-- Stores inbound prospect replies (previously only their Message-Id was
-- recorded for dedup, so the body/thread was lost) and lets outbound rows
-- carry Mailgun's message id so future replies can be matched by
-- In-Reply-To instead of "latest lead with this email".

alter table outreach_log add column if not exists provider_message_id text;
create index if not exists outreach_log_provider_message_id_idx on outreach_log (provider_message_id);

create table if not exists inbound_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  mailbox_id uuid references mailboxes(id) on delete set null,
  campaign_id uuid,
  provider_message_id text not null,
  in_reply_to text,
  subject text,
  body text,
  classification text,
  received_at timestamptz not null default now(),
  unique (client_id, provider_message_id)
);
create index if not exists inbound_messages_lead_idx on inbound_messages (lead_id, received_at desc);

alter table inbound_messages enable row level security;
drop policy if exists inbound_messages_select_own on inbound_messages;
create policy inbound_messages_select_own on inbound_messages for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));
