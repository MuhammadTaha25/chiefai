-- Weekly content plan for the social scheduler: one row per client and week (Monday date), holding the week's
-- planned posts (key "weekday:slot", pillar, product, CTA, title, hook, visual idea). Written by the cron with the
-- service role; no client policies (clients do not read or write it directly).
create table if not exists social_week_plan (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  week_start date not null,
  entries jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (client_id, week_start)
);
alter table social_week_plan enable row level security;
