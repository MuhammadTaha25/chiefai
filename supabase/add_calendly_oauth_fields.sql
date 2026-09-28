-- Run in Supabase SQL editor. Adds OAuth token storage for the real
-- "Connect Calendly" flow (src/app/api/calendly/connect + callback),
-- alongside the existing calendly_url column which the manual-paste form
-- (src/components/calendly-settings.tsx) already writes to — the OAuth
-- callback populates calendly_url too (from the connected user's
-- scheduling_url) so both paths feed the same field the outreach/nurture
-- flow reads.

alter table clients add column if not exists calendly_access_token text;
alter table clients add column if not exists calendly_refresh_token text;
alter table clients add column if not exists calendly_token_expires_at timestamptz;
alter table clients add column if not exists calendly_user_uri text;
alter table clients add column if not exists calendly_organization_uri text;
alter table clients add column if not exists calendly_connected_at timestamptz;
