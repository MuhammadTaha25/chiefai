-- Run in Supabase SQL editor. The Zernio OAuth callback upserts into
-- social_connections using ON CONFLICT (client_id, platform), but no unique
-- constraint enforced that pair — every connect attempt would fail with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".

alter table social_connections
  add constraint social_connections_client_platform_key unique (client_id, platform);
