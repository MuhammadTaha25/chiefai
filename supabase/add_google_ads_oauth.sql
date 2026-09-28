-- Run in Supabase SQL editor. Google Ads connects through Zernio (like
-- Instagram/Facebook), so the connection itself is stored in
-- social_connections (platform = 'google_ads'). This just caches the actual
-- Google Ads customer id (Zernio's "adAccountId") needed for campaign calls.

alter table clients add column if not exists google_ads_customer_id text;
