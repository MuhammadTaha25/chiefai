-- Run in Supabase SQL editor. Non-destructive: only adds columns/tables.
--
-- 1. Business onboarding knowledge (products, outcomes, positioning proof,
--    brand, goals, CTA) on client_social_profile — the existing per-client
--    knowledge row. business_id in the product spec == clients.id here.
-- 2. Strategy metadata + content history columns on social_posts.
-- 3. social_interactions: every comment/DM the AI handled (intent, retrieved
--    context reference, reply, handoff) — also the conversation memory.
-- 4. social_initial_runs: the one-time post-connection validation cycle.

-- ---- 1. business knowledge -------------------------------------------------
alter table client_social_profile add column if not exists location text;
alter table client_social_profile add column if not exists products jsonb not null default '[]'::jsonb;
alter table client_social_profile add column if not exists focus_products text[] not null default '{}';
alter table client_social_profile add column if not exists desired_outcomes text;
alter table client_social_profile add column if not exists why_choose_us text;
alter table client_social_profile add column if not exists proof text;
alter table client_social_profile add column if not exists tagline text;
alter table client_social_profile add column if not exists visual_style text;
alter table client_social_profile add column if not exists brand_colors text[] not null default '{}';
alter table client_social_profile add column if not exists primary_goal text;
alter table client_social_profile add column if not exists secondary_goal text;
alter table client_social_profile add column if not exists primary_cta text;
alter table client_social_profile add column if not exists cta_destination text;
alter table client_social_profile add column if not exists cta_phrase text;

-- ---- 2. social_posts: why each post exists + history ----------------------
alter table social_posts add column if not exists content_pillar text;
alter table social_posts add column if not exists content_objective text;
alter table social_posts add column if not exists target_audience text;
alter table social_posts add column if not exists product_name text;
alter table social_posts add column if not exists hook text;
alter table social_posts add column if not exists cta text;
alter table social_posts add column if not exists hashtags text[] not null default '{}';
alter table social_posts add column if not exists story_media_url text;
alter table social_posts add column if not exists story_zernio_post_id text;
alter table social_posts add column if not exists scheduled_for timestamptz;
alter table social_posts add column if not exists dedupe_key text;
alter table social_posts add column if not exists created_at timestamptz default now();

-- One row per generation slot per client: a retried job cannot double-insert.
create unique index if not exists social_posts_client_dedupe_key
  on social_posts (client_id, dedupe_key) where dedupe_key is not null;

-- ---- 3. comment / DM interactions ------------------------------------------
create table if not exists social_interactions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),           -- == business_id
  social_account_id text not null,                          -- Zernio account id the event arrived on
  platform text not null check (platform in ('instagram', 'facebook')),
  interaction_type text not null check (interaction_type in ('comment', 'dm')),
  external_id text not null,                                -- comment id / message id
  conversation_id text,                                     -- DMs: Zernio conversation id
  post_id text,                                             -- comments: platform post id
  commenter_id text,
  message_text text not null,
  detected_intent text,
  requires_human boolean not null default false,
  handoff_reason text,
  retrieved_context jsonb,                                  -- which sections/products grounded the reply (reference, not the full text)
  ai_response text,
  response_status text not null default 'pending'
    check (response_status in ('pending', 'sent', 'flagged_for_human', 'send_failed', 'blocked_by_validation', 'ignored')),
  created_at timestamptz not null default now(),
  unique (client_id, platform, interaction_type, external_id)
);

create index if not exists social_interactions_conversation
  on social_interactions (client_id, conversation_id, created_at desc);

alter table social_interactions enable row level security;
create policy "clients read own social interactions"
  on social_interactions for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));
-- Writes are service-role only (the webhook).

-- ---- 4. initial validation cycle -------------------------------------------
-- One row per client: created the first time a Facebook/Instagram account is
-- connected (insert ... on conflict do nothing), so reconnecting never starts a
-- second cycle. `steps` records each published item so a retry resumes instead
-- of re-publishing.
create table if not exists social_initial_runs (
  client_id uuid primary key references clients(id),
  run_after timestamptz not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'waiting_profile', 'completed', 'failed')),
  lease_until timestamptz,
  attempts int not null default 0,
  steps jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table social_initial_runs enable row level security;
create policy "clients read own initial run"
  on social_initial_runs for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));
