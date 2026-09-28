-- CRITICAL, project-wide fix. Empirically confirmed (planted a real row via
-- service_role, then queried as the signed-in owner) that these tables are
-- missing a working SELECT policy: the owner cannot read their OWN data.
-- This affects Leads, Content, Settings (domains/mailboxes/social), Finance
-- (proposals/ledger), Projects, and Ads (ad_campaigns) pages across the app.
--
-- Run in Supabase SQL editor. Safe to run multiple times (drop-if-exists first).

drop policy if exists "clients read own leads" on leads;
create policy "clients read own leads" on leads for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own domains" on domains;
create policy "clients read own domains" on domains for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own mailboxes" on mailboxes;
create policy "clients read own mailboxes" on mailboxes for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own outreach log" on outreach_log;
create policy "clients read own outreach log" on outreach_log for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own social profile" on client_social_profile;
create policy "clients read own social profile" on client_social_profile for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own social connections" on social_connections;
create policy "clients read own social connections" on social_connections for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own social posts" on social_posts;
create policy "clients read own social posts" on social_posts for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own proposals" on proposals;
create policy "clients read own proposals" on proposals for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own ledger entries" on ledger_entries;
create policy "clients read own ledger entries" on ledger_entries for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own calls" on client_calls;
create policy "clients read own calls" on client_calls for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own phone numbers" on client_phone_numbers;
create policy "clients read own phone numbers" on client_phone_numbers for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own projects" on projects;
create policy "clients read own projects" on projects for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own appointments" on appointments;
create policy "clients read own appointments" on appointments for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own ad campaigns" on ad_campaigns;
create policy "clients read own ad campaigns" on ad_campaigns for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

-- Sanity check afterwards — should list a select policy for every table above:
select tablename, policyname, cmd from pg_policies
where tablename in (
  'leads','domains','mailboxes','outreach_log','client_social_profile',
  'social_connections','social_posts','proposals','ledger_entries',
  'client_calls','client_phone_numbers','projects','appointments','ad_campaigns'
)
and cmd = 'select'
order by tablename;
