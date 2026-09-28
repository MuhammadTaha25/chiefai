-- Run in Supabase SQL editor. Phase 1 of the monthly Vibe Prospecting +
-- outreach + Calendly booking system (see FINAL MASTER PROMPT).
--
-- Reuses existing `clients`, `leads`, `outreach_log`, `mailboxes` — this only
-- adds what doesn't already exist: one row per client per month to track a
-- campaign's lifecycle, a `campaign_id` link on leads/outreach so every send
-- traces back to the month it belongs to, and a bookings table that is the
-- single source of truth for "did a real Calendly meeting get scheduled",
-- separate from "did we send a Calendly link" (leads/outreach already cover
-- the latter).

-- ============================================================
-- campaigns: one row per client per calendar month
-- ============================================================
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),

  -- First day of the campaign's month, e.g. '2026-09-01' — a date (not a
  -- free-text "2026-09" string) sorts/queries naturally and pairs cleanly
  -- with the unique constraint below.
  campaign_month date not null,

  status text not null default 'pending'
    check (status in ('pending', 'active', 'completed', 'failed')),

  target_leads integer not null default 12,
  generated_leads integer not null default 0,
  eligible_leads integer not null default 0,
  sent_count integer not null default 0,
  reply_count integer not null default 0,
  booking_count integer not null default 0,

  last_error text,

  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,

  -- The core idempotency guarantee from the spec: the monthly scheduler can
  -- run twice (retry, overlapping cron, manual trigger) without ever
  -- producing two campaigns for the same client/month.
  unique (client_id, campaign_month)
);

create index if not exists campaigns_client_idx on campaigns(client_id);
create index if not exists campaigns_month_idx on campaigns(campaign_month);

alter table campaigns enable row level security;

drop policy if exists "clients read own campaigns" on campaigns;
create policy "clients read own campaigns"
  on campaigns for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

-- ============================================================
-- leads / outreach_log: link each row to the campaign it belongs to
-- ============================================================
-- Nullable — historical leads/outreach predate campaigns and stay
-- attributable to "no campaign" rather than being force-fit into one.
alter table leads add column if not exists campaign_id uuid references campaigns(id);
alter table outreach_log add column if not exists campaign_id uuid references campaigns(id);

create index if not exists leads_campaign_idx on leads(campaign_id);
create index if not exists outreach_log_campaign_idx on outreach_log(campaign_id);

-- ============================================================
-- bookings: source of truth for confirmed Calendly meetings only.
-- A link sent, or a Calendly page opened/clicked, is NEVER a row here —
-- only Calendly confirming an actual scheduled event creates one.
-- ============================================================
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  lead_id uuid not null references leads(id),
  campaign_id uuid references campaigns(id),

  -- Calendly's own event identifier — the idempotency key. The same webhook
  -- redelivered (or fired twice for any reason) must resolve to this same
  -- row, never a second booking.
  calendly_event_id text not null unique,

  booking_status text not null default 'scheduled'
    check (booking_status in ('scheduled', 'canceled')),

  invitee_email text,
  scheduled_at timestamptz,
  meeting_duration integer not null default 30,
  event_type text,
  booking_url text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bookings_client_idx on bookings(client_id);
create index if not exists bookings_lead_idx on bookings(lead_id);
create index if not exists bookings_campaign_idx on bookings(campaign_id);

alter table bookings enable row level security;

drop policy if exists "clients read own bookings" on bookings;
create policy "clients read own bookings"
  on bookings for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

-- A confirmed booking is the strongest possible stop signal — mirrors
-- email_bounced/unsubscribed as a permanent suppression flag on the lead
-- itself, so every follow-up check (cron, webhook, manual) only has to look
-- at `leads`, not join out to `bookings` every time.
alter table leads add column if not exists booked boolean not null default false;
