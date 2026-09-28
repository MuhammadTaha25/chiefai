-- Run in Supabase SQL editor. Same class of bug as the earlier `clients` RLS
-- issue: budget_requests and department_budgets are missing a working SELECT
-- policy, so the owning user can't read their own rows (confirmed empirically:
-- inserted a row via service_role, then queried as the signed-in owner and
-- got an empty result).

-- Inspect what's currently there first:
select tablename, policyname, cmd, qual from pg_policies
where tablename in ('budget_requests', 'department_budgets');

drop policy if exists "clients read own budget requests" on budget_requests;
create policy "clients read own budget requests"
  on budget_requests for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own department budgets" on department_budgets;
create policy "clients read own department budgets"
  on department_budgets for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));
