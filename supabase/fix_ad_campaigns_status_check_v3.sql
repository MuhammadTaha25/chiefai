-- Phase 3 fix. src/lib/ad-pause.ts (autoPauseAdsForDepartment) writes
-- status = 'paused', which the v2 constraint rejected — the update error was
-- ignored, so the campaign was paused on Zernio/Meta but the app still showed
-- it as 'launched'. Add 'paused' to the allowed set.
alter table ad_campaigns drop constraint if exists ad_campaigns_status_check;
alter table ad_campaigns add constraint ad_campaigns_status_check
  check (status in (
    'generating', 'launched', 'paused',
    'approved', 'declined', 'pending_human',
    'error', 'approved_pending_manual_launch'
  ));
