-- Run in Supabase SQL editor (project timfpxablcdgwrkucrjj) to diagnose/fix.
-- 1. See what policies currently exist on `clients`:
select policyname, cmd, qual, with_check from pg_policies where tablename = 'clients';

-- 2. If the select policy is missing or wrong, (re)create it:
drop policy if exists "clients read own row" on clients;
create policy "clients read own row"
  on clients for select
  using (auth_user_id = auth.uid());

-- 3. Repeat the pattern check for every other client-scoped table —
--    this same gap may exist elsewhere (leads, projects, budget_requests, etc).
-- select policyname, cmd, tablename from pg_policies where schemaname = 'public';
