-- PRE-EXISTING BUG, discovered live during the Final Staging Readiness
-- audit (2026-10-09): `domains_dns_status_check` only ever allowed
-- ('pending', 'active'). Application code has written 'provisioning_failed'
-- since before this audit (see src/lib/provision-core.ts's dnsStatusFor,
-- used throughout domain-provisioning.ts and the retry cron) — every such
-- write has been silently rejected by Postgres in this project, meaning the
-- "retry a failed provisioning attempt" path has likely never actually
-- recorded failure state correctly. This migration also adds 'disconnected'
-- for the new disconnect/reconnect feature (/api/domains/disconnect),
-- discovered to need it by the same live test.
--
-- Idempotent: drop-if-exists before re-adding.
alter table domains drop constraint if exists domains_dns_status_check;
alter table domains add constraint domains_dns_status_check
  check (dns_status = any (array['pending', 'active', 'provisioning_failed', 'disconnected']));
