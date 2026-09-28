-- ============================================================================
-- Voice agent: per-client call settings + daily report call bookkeeping.
-- Run in the Supabase SQL editor (same as the other files in supabase/).
-- Safe to re-run: every statement is IF NOT EXISTS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Where to call the owner, and whether/when to call them.
--
--    `client_phone_numbers` (already exists) is the number the CLIENT BUYS and
--    the world calls — one per client, provisioned through Twilio/ElevenLabs.
--    These columns are the opposite direction: the client's OWN personal mobile
--    that our agent dials for the daily report. They are deliberately on
--    `clients`, not on `client_phone_numbers`, because they live and die with
--    the tenant, not with a purchased number.
-- ----------------------------------------------------------------------------
alter table clients add column if not exists personal_phone_number   text;              -- E.164, e.g. +923394816706
alter table clients add column if not exists daily_call_enabled       boolean not null default false;
alter table clients add column if not exists daily_call_time          time    not null default '18:00';   -- local time in the tz below
alter table clients add column if not exists daily_call_timezone      text    not null default 'Asia/Karachi';
alter table clients add column if not exists daily_call_last_at       timestamptz;   -- when we last successfully placed the call
alter table clients add column if not exists daily_call_last_slot     text;          -- e.g. "2026-09-24" — the idempotency key, one call per day

create index if not exists clients_daily_call_idx
  on clients (daily_call_enabled, daily_call_time)
  where daily_call_enabled = true;

-- ----------------------------------------------------------------------------
-- 2) `client_calls` already exists with:
--      id, client_id, call_sid, direction, duration_seconds,
--      recording_url, transcript, created_at, phone_number_id
--    The columns below are what the inbound webhook and the outbound cron need
--    in order to record a call honestly (who called whom, how it ended, and the
--    agent's own summary) instead of only "some call happened".
-- ----------------------------------------------------------------------------
alter table client_calls add column if not exists status                     text;      -- queued | ringing | in-progress | completed | failed | no-answer | busy
alter table client_calls add column if not exists from_number                text;
alter table client_calls add column if not exists to_number                  text;
alter table client_calls add column if not exists summary                    text;      -- agent-written recap of the call
alter table client_calls add column if not exists elevenlabs_conversation_id text;      -- ElevenLabs' own conversation id
alter table client_calls add column if not exists started_at                 timestamptz;
alter table client_calls add column if not exists ended_at                   timestamptz;
alter table client_calls add column if not exists error_message              text;
alter table client_calls add column if not exists created_by                 text not null default 'agent'; -- 'agent' | 'client' | 'cron'

-- A Twilio call SID identifies exactly one call, so the webhook and the cron can
-- both record the same call without producing two rows. NULLs are allowed and
-- do not participate in the uniqueness check.
create unique index if not exists client_calls_sid_uniq
  on client_calls (call_sid)
  where call_sid is not null;

create index if not exists client_calls_client_created_idx
  on client_calls (client_id, created_at desc);

-- ----------------------------------------------------------------------------
-- 3) Row level security: a client may read their OWN calls, nothing else.
--    (Writes come from the service-role client in the webhook/cron, which
--    bypasses RLS by design — the browser never writes a call row.)
-- ----------------------------------------------------------------------------
alter table client_calls enable row level security;

drop policy if exists "clients read own calls" on client_calls;
create policy "clients read own calls"
  on client_calls for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

-- `clients` is edited by the owner through the settings form, so they need to be
-- able to write the daily-call fields on their own row only.
drop policy if exists "clients update own daily call settings" on clients;
create policy "clients update own daily call settings"
  on clients for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());
