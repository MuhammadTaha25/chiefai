-- Run in Supabase SQL editor.
--
-- Adds a public-facing slug for each client's lead-capture landing page
-- (e.g. infomist.app/lp/acme-fitness). /lp/[slug] (src/app/lp/[slug]/page.tsx)
-- and /api/public/leads (src/app/api/public/leads/route.ts) both resolve the
-- client from this slug alone, so it must be unique across all clients.
--
-- Safe to re-run: `add column if not exists` is a no-op if the column is
-- already there, and dropping+re-adding the named unique constraint avoids a
-- "constraint already exists" error on a second run. Existing clients get
-- landing_slug = NULL, which does not violate uniqueness (Postgres does not
-- treat NULLs as equal to each other in a unique constraint), so no existing
-- row is touched or blocked.

alter table clients add column if not exists landing_slug text;

alter table clients drop constraint if exists clients_landing_slug_key;
alter table clients add constraint clients_landing_slug_key unique (landing_slug);
