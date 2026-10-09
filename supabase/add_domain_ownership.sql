-- P0 SECURITY FIX. Root cause (Existing-Domain Feature Audit, 2026-10-09):
-- `domains` is uniquely keyed on (client_id, domain), not on `domain` alone,
-- so two DIFFERENT clients could each insert their own row for the SAME
-- domain string. Combined with Mailgun being one shared account across all
-- tenants, Client B could type Client A's real domain into "Use an Existing
-- Domain," have Mailgun report it "active" (because Client A's real DNS
-- records satisfy it), and be treated as verified WITHOUT EVER PROVING
-- CONTROL of the domain. This table is the single, globally-unique source of
-- truth for "which one client, if any, actually controls this domain" —
-- enforced by a primary key on the normalized domain at the DB level, not an
-- application-level pre-check a concurrent request could race past.
--
-- Run in Supabase SQL editor. Idempotent (create-if-not-exists / drop-if-exists).

create table if not exists domain_ownership (
  domain text primary key,
  client_id uuid not null references clients(id),
  verified_via text not null check (verified_via in ('dns_txt_challenge', 'hostinger_purchase')),
  verified_at timestamptz not null default now()
);

create table if not exists domain_ownership_challenges (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  domain text not null,
  token text not null,
  status text not null default 'pending' check (status in ('pending', 'verified', 'expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '48 hours'),
  verified_at timestamptz,
  -- One live challenge per (client, domain): regenerating overwrites the
  -- previous token rather than accumulating rows (see domain-ownership.ts
  -- startOwnershipChallenge, which upserts on this constraint).
  unique (client_id, domain)
);

alter table domain_ownership enable row level security;
alter table domain_ownership_challenges enable row level security;

drop policy if exists "clients read own domain ownership" on domain_ownership;
create policy "clients read own domain ownership" on domain_ownership for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

drop policy if exists "clients read own domain challenges" on domain_ownership_challenges;
create policy "clients read own domain challenges" on domain_ownership_challenges for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- AUDIT QUERY — run this FIRST and review the results manually. Per the P0
-- fix instructions, existing duplicate/colliding domain rows are never
-- auto-resolved, deleted, or reassigned by this migration. Any domain string
-- below has more than one client with an "active" row today — a real
-- pre-existing collision from before this fix existed. Decide by hand
-- (support ticket, contacting both clients, checking who actually controls
-- the domain) which tenant, if any, should hold `domain_ownership` for it,
-- then insert that single row yourself before relying on this table for it.
--
-- select domain, array_agg(distinct client_id) as clients, count(distinct client_id) as tenant_count
-- from domains
-- where dns_status = 'active'
-- group by domain
-- having count(distinct client_id) > 1;
-- ---------------------------------------------------------------------------

-- SAFE ONE-TIME BACKFILL — only for domains that are UNAMBIGUOUS today
-- (exactly one client has ever had that domain string active). Domains
-- flagged by the audit query above are deliberately left untouched.
--
-- NOTE: `count(distinct ...)` is not valid as a window function in
-- Postgres ("DISTINCT is not implemented for window functions") — confirmed
-- live when this migration was first applied to staging (2026-10-09). Uses
-- a correlated subquery instead of `... over (partition by domain)`.
insert into domain_ownership (domain, client_id, verified_via, verified_at)
select d.domain, d.client_id,
  case when d.dns_managed_externally then 'dns_txt_challenge' else 'hostinger_purchase' end,
  now()
from domains d
where d.dns_status = 'active'
and (select count(distinct d2.client_id) from domains d2 where d2.domain = d.domain and d2.dns_status = 'active') = 1
on conflict (domain) do nothing;
