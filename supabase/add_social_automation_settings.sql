-- Run in Supabase SQL editor. Backs the Social Media Automation module.
-- One row per client+platform. Stores only configuration — never tokens/secrets
-- (those live in social_connections.zernio_account_id, which n8n/Zernio use server-side).

create table if not exists social_automation_settings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  platform text not null check (platform in ('instagram', 'facebook', 'linkedin', 'tiktok', 'youtube')),

  posts_per_week int not null default 3,
  image_posts_per_week int not null default 2,
  carousel_posts_per_week int not null default 1,
  video_posts_per_week int not null default 0,
  stories_per_week int not null default 3,

  content_preference text not null default 'ai_full' check (content_preference in ('ai_full', 'ai_draft', 'user_assisted')),
  approval_mode text not null default 'full_automation' check (approval_mode in ('full_automation', 'approval_required', 'draft_only')),
  publish_mode text not null default 'schedule' check (publish_mode in ('immediate', 'schedule', 'approval_required')),

  auto_create_enabled boolean not null default false,
  auto_publish_enabled boolean not null default false,
  stories_enabled boolean not null default false,
  dm_enabled boolean not null default false,
  human_handoff_enabled boolean not null default true,
  comment_enabled boolean not null default false,
  lead_detection_enabled boolean not null default true,
  analytics_enabled boolean not null default true,

  automation_active boolean not null default false,
  activated_at timestamptz,
  paused_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (client_id, platform)
);

alter table social_automation_settings enable row level security;

create policy "clients read own social automation settings"
  on social_automation_settings for select
  using (client_id in (select id from clients where auth_user_id = auth.uid()));

create policy "clients manage own social automation settings"
  on social_automation_settings for all
  using (client_id in (select id from clients where auth_user_id = auth.uid()))
  with check (client_id in (select id from clients where auth_user_id = auth.uid()));
