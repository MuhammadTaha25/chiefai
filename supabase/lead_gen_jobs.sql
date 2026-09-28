-- Run this in the Supabase SQL editor (project timfpxablcdgwrkucrjj).
-- Backs the new self-explanatory "Find Leads" intake form (src/app/(dashboard)/lead-gen/page.tsx),
-- which POSTs the full structured criteria here before handing off to n8n's lead-gen webhook.

create table if not exists lead_gen_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  status text not null default 'pending',
  criteria jsonb not null,
  leads_found integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table lead_gen_jobs enable row level security;

create policy "clients read own lead-gen jobs"
  on lead_gen_jobs for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

create policy "clients insert own lead-gen jobs"
  on lead_gen_jobs for insert
  with check (client_id in (select id from clients where auth_user_id = auth.uid()));
