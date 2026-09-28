-- Run this in the Supabase SQL editor (project timfpxablcdgwrkucrjj).
-- Backs the Google/Meta/Instagram ad-creation + audit workflows in n8n,
-- which currently reference this table via placeholder REST URLs.

create table if not exists ad_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  platform text not null check (platform in ('google_ads', 'meta_ads', 'instagram_ads')),
  status text not null default 'pending',
  campaign_id text,
  brief jsonb,
  zernio_ad_id text,
  external_campaign_id text,
  external_ad_group_id text,
  external_ad_id text,
  zernio_status text,
  audit_status text,
  audit_ctr numeric,
  audit_cpa numeric,
  root_cause text,
  recommended_action text,
  audited_at timestamptz,
  previous_job_id uuid references ad_generation_jobs(id),
  regeneration_root_cause text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table ad_generation_jobs enable row level security;

create policy "clients read own ad jobs"
  on ad_generation_jobs for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

create policy "clients insert own ad jobs"
  on ad_generation_jobs for insert
  with check (client_id in (select id from clients where auth_user_id = auth.uid()));
