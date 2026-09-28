-- Run in Supabase SQL editor. outreach_log previously only recorded that a
-- touch happened (lead_id, mailbox_id, sent_at, touch_number) with no way to
-- see what was actually sent — needed for the per-lead sent-email history UI.

alter table outreach_log add column if not exists subject text;
alter table outreach_log add column if not exists body text;

comment on column outreach_log.subject is 'Email subject line as sent — null for older rows recorded before this column existed.';
comment on column outreach_log.body is 'Plain-text email body as sent — null for older rows recorded before this column existed.';
