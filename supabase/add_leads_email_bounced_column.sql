-- Run in Supabase SQL editor. Without this, a lead whose email address
-- hard-bounced (Mailgun "failed" event — mailbox doesn't exist) kept
-- receiving scheduled follow-ups forever, wasting sends and hurting sender
-- reputation. Set by /api/domains/mailboxes/[id]/sent-emails (lazily, when a
-- client views that mailbox's sent emails and a bounce is detected in
-- Mailgun's event log) and checked by /api/cron/follow-ups.

alter table leads add column if not exists email_bounced boolean not null default false;

comment on column leads.email_bounced is
  'True once Mailgun reports a hard bounce for this lead''s email — stops further follow-ups.';
