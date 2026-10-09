-- Signup email verification: a 6-digit code + a link token, sent together in one
-- email, either of which completes verification. Keyed by email, not by
-- auth_user_id/session, because Supabase's own "Confirm email" project setting
-- (if ON) can mean the browser has no session yet when this flow runs — the
-- email the user typed at signup is the only identity available at that point.
--
-- Idempotent (create-if-not-exists / drop-if-exists). Run in Supabase SQL editor.

create table if not exists signup_email_verifications (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code text not null,
  token text not null unique,
  status text not null default 'pending' check (status in ('pending', 'verified', 'expired')),
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  verified_at timestamptz
);

create index if not exists signup_email_verifications_email_idx on signup_email_verifications (email);

alter table signup_email_verifications enable row level security;
-- No client-facing policies: only the service-role (admin) client reads/writes this
-- table, matching the column-privilege pattern used for `clients` in harden_clients_privileges.sql.
