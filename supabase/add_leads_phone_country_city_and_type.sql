-- Run in Supabase SQL editor.
--
-- 1. The ads landing page (src/app/lp/[slug]/page.tsx via
--    src/components/landing-form.tsx) collects Phone/Country/City in addition
--    to Name/Email/Company — add columns to hold them.
-- 2. Every lead needs to be bucketed as "inbound" (clicked a Facebook/
--    Instagram ad, landed on our page, filled the form themselves) vs
--    "outbound" (we sourced/emailed them first — manual entry, AI
--    prospecting, vibe prospecting) so the two can be reported on and
--    filtered separately in the Leads dashboard.
--
-- Safe to re-run:
--  - `add column if not exists` is a no-op if a column is already there.
--  - lead_type defaults to 'outbound', so all currently-existing leads (22
--    at last count, sources: manual / ai_prospecting / vibe_prospecting /
--    lead_connector / qa_test / null) keep their data and are simply
--    classified outbound — nothing is deleted or overwritten.
--  - The CHECK constraint is dropped-and-re-added by name, so re-running
--    this file doesn't error with "constraint already exists".
--  - The backfill UPDATE only touches rows where lead_source = 'landing_page'
--    (currently 0 rows, since this is the first time that source exists) and
--    only ever sets lead_type = 'inbound' on those — running it again is a
--    no-op, not a duplicate change.

alter table leads add column if not exists phone text;
alter table leads add column if not exists country text;
alter table leads add column if not exists city text;

alter table leads add column if not exists lead_type text not null default 'outbound';

alter table leads drop constraint if exists leads_lead_type_check;
alter table leads add constraint leads_lead_type_check check (lead_type in ('inbound', 'outbound'));

-- Backfill: anything that already came from the public landing page form is inbound.
-- Everything else (manual / ai_prospecting / vibe_prospecting / lead_connector /
-- qa_test / null) keeps the 'outbound' default set above.
update leads set lead_type = 'inbound' where lead_source = 'landing_page';
