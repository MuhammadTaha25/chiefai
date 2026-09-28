-- Run in Supabase SQL editor. ad_campaigns_platform_check only allows the
-- ad_generation_jobs-style values ('google_ads','meta_ads','instagram_ads'),
-- but the ads-creative-brief n8n workflow's "Create ad_campaigns Row (draft)"
-- node writes platform straight from the webhook body's zernio-style value
-- ("facebook"/"instagram"/"google_ads" — see zernioPlatform in
-- src/app/api/ads/[platform]/route.ts), so every insert fails with:
--   new row for relation "ad_campaigns" violates check constraint
--   "ad_campaigns_platform_check"
-- This widens the constraint to accept both naming conventions.

alter table ad_campaigns drop constraint if exists ad_campaigns_platform_check;
alter table ad_campaigns add constraint ad_campaigns_platform_check
  check (platform in (
    'google_ads', 'meta_ads', 'instagram_ads',
    'facebook', 'instagram'
  ));
