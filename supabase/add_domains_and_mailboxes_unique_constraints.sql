-- Run in Supabase SQL editor.
--
-- domain-registration.ts and /api/domains/mailboxes both used a
-- check-then-insert pattern ("SELECT to see if it already exists, THEN
-- INSERT if not") to guard against duplicate rows on Stripe webhook
-- redelivery / retry. That guard is not atomic — two calls racing each
-- other can both pass the SELECT before either INSERT lands, so both
-- insert. Confirmed live: client 40a5846c-41c5-42c4-9d99-0a77cf8201ac has
-- two `domains` rows each for vidfetch.online and link2video.online.
--
-- This migration:
--   1. Dedupes existing duplicate `domains` rows (keeps the one with
--      dns_status = 'active' if any, else the most recently created one;
--      no data is lost — the row that's kept is the one accurately
--      reflecting the domain's real state).
--   2. Adds a unique constraint on (client_id, domain) so this can never
--      happen again, regardless of how many times a webhook redelivers.
--   3. Adds the equivalent (client_id, address) unique constraint on
--      `mailboxes` pre-emptively — no duplicates exist there today, but the
--      same race was possible in the same code paths.
--
-- The application code (src/lib/domain-registration.ts and
-- src/app/api/domains/mailboxes/route.ts) is updated in the same change to
-- upsert with onConflict + ignoreDuplicates instead of select-then-insert,
-- so a race now safely no-ops instead of inserting a second row.

with ranked as (
  select id,
         row_number() over (
           partition by client_id, domain
           order by (dns_status = 'active') desc, created_at desc, id desc
         ) as rn
  from domains
)
delete from domains
where id in (select id from ranked where rn > 1);

alter table domains drop constraint if exists domains_client_domain_key;
alter table domains add constraint domains_client_domain_key unique (client_id, domain);

alter table mailboxes drop constraint if exists mailboxes_client_address_key;
alter table mailboxes add constraint mailboxes_client_address_key unique (client_id, address);
