-- Applied to the live project. A business gets a new first-connection cycle when it connects a DIFFERENT
-- Facebook/Instagram account (account_id changes) or when one is forced from the QA route; each cycle uses its
-- own dedupe keys (initial_c<cycle>_<step>; cycle 1 keeps the original initial_<step>).
alter table social_initial_runs add column if not exists cycle int not null default 1;
alter table social_initial_runs add column if not exists account_id text;
