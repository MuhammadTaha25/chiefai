-- Run in Supabase SQL editor (project timfpxablcdgwrkucrjj).
-- Fixes: Instagram/Facebook DM + comment auto-reply agent re-sending a freshly
-- AI-regenerated reply every time Meta redelivers the same webhook event
-- (Meta retries webhook delivery on slow/failed acks). This table gives the
-- n8n workflow an idempotency check: before generating a reply, look up
-- (platform, external_id); if found, skip. After sending, insert the row.

create table if not exists social_reply_log (
  id uuid primary key default gen_random_uuid(),
  platform text not null check (platform in ('instagram', 'facebook')),
  event_type text not null check (event_type in ('comment', 'dm')),
  external_id text not null, -- comment id for comments; message.mid (Meta's own message id) for DMs
  client_id uuid references clients(id),
  reply_text text,
  created_at timestamptz not null default now(),
  unique (platform, event_type, external_id)
);

alter table social_reply_log enable row level security;

-- Written only by the n8n service role; no client-facing policy needed beyond
-- read access for the dashboard to show "responses sent" reporting later.
create policy "clients read own social reply log"
  on social_reply_log for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));
