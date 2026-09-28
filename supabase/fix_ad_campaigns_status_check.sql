-- Run in Supabase SQL editor. ad_campaigns_status_check only allows the
-- workflow's own draft statuses ('generating','launched'), but
-- decide_ad_finance can also return 'approved' | 'declined' | 'pending_human'
-- (same three values budget_requests_status_check already allows — see
-- fix_budget_requests_status_check.sql), which the "Mark Campaign Blocked
-- (Finance)" n8n node writes straight into ad_campaigns.status. This widens
-- the constraint to allow all statuses either path can produce.

alter table ad_campaigns drop constraint if exists ad_campaigns_status_check;
alter table ad_campaigns add constraint ad_campaigns_status_check
  check (status in (
    'generating', 'launched',
    'approved', 'declined', 'pending_human'
  ));
