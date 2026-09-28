-- Run in Supabase SQL editor. The in-app ads pipeline (replacing the n8n
-- workflow) needs two more terminal states the existing constraint doesn't
-- allow: 'error' (creative generation / finance RPC / launch call itself
-- threw, distinct from a finance 'declined') and
-- 'approved_pending_manual_launch' (Google Ads — approved by Finance but not
-- auto-launched since no tested Zernio/Google Ads launch payload exists yet;
-- see src/app/api/ads/[platform]/route.ts).

alter table ad_campaigns drop constraint if exists ad_campaigns_status_check;
alter table ad_campaigns add constraint ad_campaigns_status_check
  check (status in (
    'generating', 'launched',
    'approved', 'declined', 'pending_human',
    'error', 'approved_pending_manual_launch'
  ));
