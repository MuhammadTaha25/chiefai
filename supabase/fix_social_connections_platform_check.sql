-- Run in Supabase SQL editor. social_connections_platform_check was never
-- updated when facebook_ads/instagram_ads/google_ads were split out as their
-- own platform values (see src/app/api/zernio/connect/route.ts VALID_PLATFORMS),
-- so connecting Facebook/Instagram/Google Ads fails with:
--   new row for relation "social_connections" violates check constraint
--   "social_connections_platform_check"
-- This widens the constraint to match the app's full VALID_PLATFORMS list.

alter table social_connections drop constraint if exists social_connections_platform_check;
alter table social_connections add constraint social_connections_platform_check
  check (platform in (
    'instagram', 'facebook', 'linkedin', 'tiktok', 'youtube',
    'google_ads', 'facebook_ads', 'instagram_ads'
  ));
