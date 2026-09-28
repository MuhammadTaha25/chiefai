-- Run in Supabase SQL editor. Stores the OAuth tokens for server-side MCP
-- clients (e.g. Vibe Prospecting) — one row per provider, so the app's
-- backend can reuse a single authorized connection across all requests
-- instead of every request needing its own interactive OAuth.
--
-- Service-role only: no RLS policies are added on purpose — clients never
-- read this table directly, only src/lib/vibe-prospecting-mcp.ts via the
-- admin client.

create table if not exists mcp_oauth_tokens (
  provider text primary key,
  access_token text not null,
  refresh_token text,
  expires_at timestamptz,
  code_verifier text,
  client_id text,
  client_secret text,
  updated_at timestamptz not null default now()
);

alter table mcp_oauth_tokens enable row level security;
-- No policies added — table is accessed exclusively via the service-role
-- admin client from server-side code, never from an authenticated client session.
