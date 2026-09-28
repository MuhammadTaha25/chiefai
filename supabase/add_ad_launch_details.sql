-- Run in Supabase SQL editor (project timfpxablcdgwrkucrjj).
--
-- Records the FULL Meta hierarchy a live ad is made of, so the app can prove
-- what it launched instead of only storing one campaign id:
--
--   ad_campaigns.zernio_campaign_id  -> Meta campaign  (objective / budget model)
--   ad_campaigns.ad_set_id           -> Meta ad set    (budget, geo, age, gender, placements, optimization)
--   ad_campaigns.ad_id               -> Meta ad        (creative + delivery)
--   ad_campaigns.creative_id         -> Meta creative
--   ad_campaigns.image_url           -> the AI-generated image attached to the ad
--   ad_campaigns.targeting           -> exactly what we sent, for auditing a spend decision
--   ad_campaigns.launch_payload      -> notes/warnings shown to the user after launch
--   ad_campaigns.reach_estimate      -> the pre-flight audience size (Meta rejects < 1,000)
--
-- Before this, POST /v1/ads/campaigns was called with a payload it does not
-- accept, so only a bare campaign ever existed and there was nothing to store
-- the ad set or ad in. Without these columns a launched ad cannot be paused,
-- synced or audited per level.

alter table ad_campaigns add column if not exists objective text;
alter table ad_campaigns add column if not exists optimization_goal text;
alter table ad_campaigns add column if not exists ad_set_id text;
alter table ad_campaigns add column if not exists ad_id text;
alter table ad_campaigns add column if not exists creative_id text;
alter table ad_campaigns add column if not exists ad_set_name text;
alter table ad_campaigns add column if not exists ad_name text;
alter table ad_campaigns add column if not exists image_url text;
alter table ad_campaigns add column if not exists targeting jsonb;
alter table ad_campaigns add column if not exists launch_payload jsonb;
alter table ad_campaigns add column if not exists reach_estimate jsonb;

-- Widen the status check to the values this app now writes. The v3 migration
-- allowed ('generating','launched','paused','approved','declined',
-- 'pending_human','error','approved_pending_manual_launch'); 'rejected' is what
-- decide_ad_finance returns when a prior ad underperformed, and 'live' is the
-- explicit "provider confirmed and delivering" state.
alter table ad_campaigns drop constraint if exists ad_campaigns_status_check;
alter table ad_campaigns add constraint ad_campaigns_status_check
  check (status in (
    'draft', 'generating', 'pending_audit', 'audit_failed',
    'pending_finance', 'approved', 'declined', 'rejected', 'pending_human',
    'launched', 'live', 'paused',
    'error', 'approved_pending_manual_launch', 'duplicate'
  ));

create index if not exists ad_campaigns_ad_set_idx on ad_campaigns(ad_set_id);
create index if not exists ad_campaigns_ad_idx on ad_campaigns(ad_id);
