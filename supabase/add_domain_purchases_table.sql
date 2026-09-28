-- Run in Supabase SQL editor. Backs the domain purchase flow (ZERNIO_META_ADS_SPEC.md §6):
-- client picks a domain -> we charge them $15 via Stripe (sandbox) -> once payment
-- succeeds we register the domain via Hostinger's API. One row per attempt so a
-- failed Hostinger registration after a successful charge is visible and retryable.

create table if not exists domain_purchases (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  domain text not null,
  tld text not null,
  amount_cents integer not null default 1500,
  currency text not null default 'usd',

  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'paid', 'registering', 'registered', 'payment_failed', 'registration_failed')),

  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  hostinger_order_id text,
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists domain_purchases_client_idx on domain_purchases(client_id);

alter table domain_purchases enable row level security;

drop policy if exists "clients read own domain purchases" on domain_purchases;
create policy "clients read own domain purchases"
  on domain_purchases for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));
