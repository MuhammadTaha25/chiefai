-- Phase 3 security fix. Verified with a real authenticated tenant: the
-- "update own row" RLS policy on `clients` let a signed-in user rewrite
-- privileged columns of their own row (onboarding_status, status,
-- stripe_customer_id, stripe_payment_method_token, sending_domain,
-- zernio_profile_id*, calendly_* tokens/webhook keys, google_ads_customer_id).
-- RLS is row-level only, so restrict at COLUMN level: browsers/anon-key
-- sessions may only edit the business-profile fields; every other write goes
-- through server routes using the service-role client (which is unaffected).
revoke update on public.clients from anon, authenticated;
grant update (icp_industry, icp_min_employees, icp_max_employees, icp_location, landing_slug)
  on public.clients to authenticated;
-- Verify: select grantee, column_name from information_schema.column_privileges
--   where table_name='clients' and privilege_type='UPDATE' and grantee in ('authenticated','anon');
