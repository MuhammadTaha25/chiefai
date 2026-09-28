-- Run in Supabase SQL editor. client_social_profile only had a SELECT policy —
-- the Business Profile page's upsert (insert-or-update) was blocked because
-- there was no policy allowing the owner to write their own row.

drop policy if exists "clients manage own social profile" on client_social_profile;
create policy "clients manage own social profile"
  on client_social_profile for all
  using (client_id in (select id from clients where auth_user_id = auth.uid()))
  with check (client_id in (select id from clients where auth_user_id = auth.uid()));

-- Also cover clients table updates (icp_industry/icp_location/etc are edited
-- from the same Business Profile form) in case it's missing too:
drop policy if exists "clients update own row" on clients;
create policy "clients update own row"
  on clients for update
  using (auth_user_id = auth.uid())
  with check (auth_user_id = auth.uid());
