-- Run in Supabase SQL editor. Instagram/Facebook DM automation silently does
-- nothing if the account owner hasn't turned on "message access" for
-- connected apps inside Instagram itself (a per-account Instagram setting,
-- confirmed via Zernio's own docs — not something any platform can bypass).
-- This tracks that state so the UI can guide the client through it instead
-- of automation quietly failing.

alter table social_connections add column if not exists inbox_enabled boolean;
alter table social_connections add column if not exists inbox_checked_at timestamptz;
