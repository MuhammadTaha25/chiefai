-- Run in Supabase SQL editor. Adds the remaining stop-condition states from
-- the FINAL MASTER PROMPT (complaint, manual-stop) alongside the existing
-- unsubscribed/email_bounced/booked columns, plus a small table so pushed
-- Mailgun/Calendly webhook events can't be processed twice.

alter table leads add column if not exists complained boolean not null default false;
alter table leads add column if not exists complained_at timestamptz;
alter table leads add column if not exists manually_stopped boolean not null default false;
alter table leads add column if not exists manually_stopped_at timestamptz;

-- Raw 4-way AI classification (BOOKING/HAPPY/ANGRY/UNCLEAR) + confidence +
-- reason for observability — kept separate from the existing `sentiment`
-- column, which has its own narrower check constraint (positive/angry/neutral)
-- that other code already depends on, so it keeps being written to for
-- backward compatibility while this column holds the real, undiluted value.
alter table leads add column if not exists reply_classification text;
alter table leads add column if not exists reply_confidence numeric;
alter table leads add column if not exists reply_reason text;

comment on column leads.complained is 'True once Mailgun reports a spam complaint for this lead — permanent suppression.';
comment on column leads.manually_stopped is 'Client/admin explicitly stopped outreach to this lead.';

-- Generic idempotency ledger for provider push-webhooks that aren't already
-- covered by an existing table's own unique key (bookings.calendly_event_id
-- already does this for Calendly; this is for Mailgun's tracking events —
-- complained/unsubscribed — which have no equivalent yet).
create table if not exists processed_provider_events (
  id text primary key, -- e.g. "mailgun:<event-id>"
  provider text not null,
  event_type text not null,
  processed_at timestamptz not null default now()
);

create index if not exists processed_provider_events_provider_idx on processed_provider_events(provider);
