-- Run in Supabase SQL editor. The existing status check constraint on
-- budget_requests doesn't allow 'pending_human', which decide_budget_request's
-- "request_human_approval" outcome needs to be recorded as. This widens the
-- constraint (adds a value, doesn't remove any existing allowed ones).

alter table budget_requests drop constraint if exists budget_requests_status_check;
alter table budget_requests add constraint budget_requests_status_check
  check (status in ('pending', 'approved', 'declined', 'pending_human'));
