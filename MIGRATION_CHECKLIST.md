# Migration Checklist — RLS & Privilege Hardening

Scope: the two security-critical migrations flagged by the QA audit —
`supabase/fix_all_client_rls.sql` and `supabase/harden_clients_privileges.sql`.
Both are **idempotent** as written (`drop policy if exists` before every
`create policy`; the privilege file only issues plain `revoke`/`grant`, which
are themselves idempotent in Postgres) — safe to re-run if you are unsure
whether they already applied.

This checklist does **not** attempt to order the full `supabase/*.sql`
history (50+ ad-hoc files, no numeric prefix/sequence). It covers only the
two files above, since those are the ones with a confirmed historical
security gap. If you need the full migration history ordered and tracked,
that is a separate, larger task — consider adopting the Supabase CLI's
`supabase migration` tooling going forward instead of hand-run SQL files.

## Why these two matter

- **`fix_all_client_rls.sql`** — without it, a signed-in client could not
  even read their own rows in `leads`, `domains`, `mailboxes`,
  `outreach_log`, `client_social_profile`, `social_connections`,
  `social_posts`, `proposals`, `ledger_entries`, `client_calls`,
  `client_phone_numbers`, `projects`, `appointments`, `ad_campaigns` — the
  file's own header says this was empirically confirmed live (a service-role
  row was invisible to its owner).
- **`harden_clients_privileges.sql`** — without it, a signed-in client could
  overwrite privileged columns on their own `clients` row —
  `stripe_customer_id`, `stripe_payment_method_token`,
  `calendly_*` tokens/webhook keys, `google_ads_customer_id`, etc. — directly
  from the browser.

If either has not been run against the live project, that gap is live
**right now**.

## Order to run

1. `supabase/fix_all_client_rls.sql`
2. `supabase/harden_clients_privileges.sql`

(No dependency between them; this order is just "read-access fix, then
write-access lockdown.")

## How to apply

1. Open the Supabase project → **SQL Editor** → **New query**.
2. Paste the full contents of `fix_all_client_rls.sql`, run it. The file ends
   with its own `select ... from pg_policies` sanity check — confirm it
   returns one `select`-cmd row per table listed.
3. Paste the full contents of `harden_clients_privileges.sql`, run it.
4. Run the verification queries below.

## Verification queries

### 1. Confirm every table has a working owner-read SELECT policy

```sql
select tablename, policyname, cmd from pg_policies
where tablename in (
  'leads','domains','mailboxes','outreach_log','client_social_profile',
  'social_connections','social_posts','proposals','ledger_entries',
  'client_calls','client_phone_numbers','projects','appointments','ad_campaigns'
)
and cmd = 'select'
order by tablename;
```

Expect exactly one row per table above. A missing table name means that
table's policy did not apply — re-run `fix_all_client_rls.sql` and check for
an error in the SQL Editor output (e.g. a typo'd table name, or the table not
existing yet in this project).

### 2. Confirm `clients` column-level UPDATE privileges are locked down

```sql
select grantee, column_name, privilege_type
from information_schema.column_privileges
where table_name = 'clients'
  and privilege_type = 'UPDATE'
  and grantee in ('authenticated', 'anon')
order by grantee, column_name;
```

Expect: **only** `authenticated` (never `anon`) with UPDATE on exactly these
five columns — `icp_industry`, `icp_min_employees`, `icp_max_employees`,
`icp_location`, `landing_slug`. Any other column name in this result means a
browser session can still rewrite something it should not (e.g.
`stripe_customer_id`) — re-run `harden_clients_privileges.sql`.

### 3. End-to-end smoke test (do this as an actual signed-in client, not service-role)

- Sign in as a real client account in the app.
- Confirm the Leads, Domains/Mailboxes, Finance (Proposals/Ledger), Projects,
  and Ads pages all show data (proves SELECT policies are active and not
  silently blocking the owner).
- From the browser dev console (while signed in), attempt a direct Supabase
  client call like:
  ```js
  await supabase.from("clients").update({ stripe_customer_id: "x" }).eq("id", MY_CLIENT_ID);
  ```
  Expect this to fail (permission denied) — if it succeeds, the hardening
  migration has not been applied.

## Future migrations

New SQL files added to `supabase/` should follow the same idempotent
pattern used here:
- `create policy` → always preceded by `drop policy if exists`.
- `alter table ... add column` → use `add column if not exists`.
- Privilege changes → plain `revoke`/`grant` (already idempotent; re-running
  is safe).
- Anything that can't be made naturally idempotent → wrap in
  `do $$ begin ... exception when ... then null; end $$;`.
