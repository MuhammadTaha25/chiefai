-- Run in Supabase SQL editor. Backs the Frontage Leads MCP OAuth connection
-- (src/lib/leads-mcp.ts). This is a single, account-level connection — one
-- Frontage Leads account/subscription used to fulfil lead searches for every
-- client of this app, not a per-client OAuth connection (unlike Calendly).
-- Hence a singleton row (id = 'default') rather than a client_id column.

create table if not exists leads_mcp_connection (
  id text primary key default 'default',

  -- Dynamic Client Registration (RFC 7591) result — registered once on first connect.
  oauth_client_id text,
  oauth_client_secret text,

  -- Current tokens (RFC 6749/OAuth 2.1).
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  scope text,

  -- Transient state for an in-progress authorization redirect — cleared once
  -- the callback consumes it. Only one connect flow can be in flight at a time.
  pending_code_verifier text,
  pending_state text,
  discovery_state jsonb,

  connected_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into leads_mcp_connection (id) values ('default')
  on conflict (id) do nothing;

-- Service-role only (src/lib/supabase/admin.ts) — no client-facing RLS
-- policy needed since this is never read from the browser or scoped per
-- client; the app's own connect/callback/tool-call routes use the admin
-- client exclusively.
alter table leads_mcp_connection enable row level security;
