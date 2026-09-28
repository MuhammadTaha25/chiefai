-- Run in Supabase SQL editor. Hard-stop flag for leads who explicitly asked
-- to be removed — checked by both the inbound reply handler and the
-- follow-up cron so an unsubscribe can never be followed by another send,
-- regardless of what Gemini's sentiment classification returns.

alter table leads add column if not exists unsubscribed boolean not null default false;
alter table leads add column if not exists unsubscribed_at timestamptz;

comment on column leads.unsubscribed is 'Hard stop — true once the lead has explicitly asked to be removed. Checked independently of AI sentiment classification.';
