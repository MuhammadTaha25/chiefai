import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Next.js's dev-mode fetch patching (Data Cache dedup/instrumentation) can
 * add tens of seconds of latency to plain external OAuth discovery/token
 * calls that have nothing to do with Next's own caching — force it off and
 * fail fast instead of silently hanging.
 */
export const noCacheFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store", signal: init?.signal ?? AbortSignal.timeout(10_000) });

/**
 * Server-only. Generic OAuth 2.1 (RFC 7591 dynamic client registration +
 * PKCE) client for a remote MCP server, backed by one row in
 * `leads_mcp_connection` per service. This is what makes
 * src/lib/leads-mcp.ts (Frontage Leads) and src/lib/vibe-prospecting-mcp.ts
 * (Explorium, branded "Vibe Prospecting" in the UI) both work — one
 * account-level connection per service, used by every client of this app.
 */

interface ConnectionRow {
  id: string;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  scope: string | null;
  pending_code_verifier: string | null;
  discovery_state: OAuthDiscoveryState | null;
}

export interface McpServiceConfig {
  connectionId: string;
  mcpUrl: string;
  serviceLabel: string;
  /** Omit (or leave empty) when the server doesn't advertise specific scopes. */
  scope?: string;
  redirectEnvVar: string;
  redirectPath: string;
}

async function getRow(config: McpServiceConfig): Promise<ConnectionRow> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("leads_mcp_connection")
    .select("*")
    .eq("id", config.connectionId)
    .single();
  if (error || !data) {
    throw new Error(
      `leads_mcp_connection row "${config.connectionId}" missing — insert it per supabase/add_leads_mcp_connection_table.sql: ${error?.message}`
    );
  }
  return data as ConnectionRow;
}

/**
 * Captures the URL `auth()` wants the user redirected to, since
 * `redirectToAuthorization` has no return value the caller can await.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  capturedAuthorizationUrl: URL | null = null;

  constructor(private config: McpServiceConfig, private redirectUriValue: string) {}

  get redirectUrl() {
    return this.redirectUriValue;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUriValue],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Infomist",
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const row = await getRow(this.config);
    if (!row.oauth_client_id) return undefined;
    return { client_id: row.oauth_client_id, client_secret: row.oauth_client_secret ?? undefined };
  }

  async saveClientInformation(info: OAuthClientInformationFull) {
    const admin = createAdminClient();
    await admin
      .from("leads_mcp_connection")
      .update({ oauth_client_id: info.client_id, oauth_client_secret: info.client_secret ?? null })
      .eq("id", this.config.connectionId);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const row = await getRow(this.config);
    if (!row.access_token) return undefined;
    return {
      access_token: row.access_token,
      refresh_token: row.refresh_token ?? undefined,
      token_type: "Bearer",
      scope: row.scope ?? undefined,
    };
  }

  async saveTokens(tokens: OAuthTokens) {
    const admin = createAdminClient();
    await admin
      .from("leads_mcp_connection")
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        token_expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
        scope: tokens.scope ?? null,
        connected_at: new Date().toISOString(),
      })
      .eq("id", this.config.connectionId);
  }

  redirectToAuthorization(authorizationUrl: URL) {
    // Server-side context — there's no browser to redirect. The calling API
    // route reads this back off the provider instance after `auth()`
    // returns 'REDIRECT' and issues the actual Next.js redirect itself.
    this.capturedAuthorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string) {
    const admin = createAdminClient();
    await admin
      .from("leads_mcp_connection")
      .update({ pending_code_verifier: codeVerifier })
      .eq("id", this.config.connectionId);
  }

  async codeVerifier(): Promise<string> {
    const row = await getRow(this.config);
    if (!row.pending_code_verifier) throw new Error("No pending PKCE code verifier — restart the connect flow");
    return row.pending_code_verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState) {
    const admin = createAdminClient();
    await admin.from("leads_mcp_connection").update({ discovery_state: state }).eq("id", this.config.connectionId);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const row = await getRow(this.config);
    return row.discovery_state ?? undefined;
  }
}

export function getRedirectUriFor(config: McpServiceConfig, origin: string) {
  return process.env[config.redirectEnvVar] || `${origin}${config.redirectPath}`;
}

export async function isMcpConnected(config: McpServiceConfig): Promise<boolean> {
  const row = await getRow(config);
  return Boolean(row.access_token);
}

/**
 * Opens (or resumes) an MCP session and calls one tool. Short-lived —
 * connects, calls, disconnects, since this runs inside a single Next.js
 * request handler rather than a long-lived process.
 */
export async function callMcpTool<T = unknown>(
  config: McpServiceConfig,
  toolName: string,
  args: Record<string, unknown>,
  redirectUri: string
): Promise<T> {
  const provider = new McpOAuthProvider(config, redirectUri);
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
    authProvider: provider,
    fetch: noCacheFetch,
  });
  const client = new Client({ name: "infomist", version: "1.0.0" });

  try {
    await client.connect(transport);
  } catch (err) {
    throw new Error(
      `${config.serviceLabel} isn't connected yet — connect it from Settings first (${(err as Error).message})`
    );
  }

  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    if (result.isError) {
      throw new Error(`${config.serviceLabel} tool "${toolName}" failed: ${JSON.stringify(result.content)}`);
    }
    return result as T;
  } finally {
    await client.close().catch(() => {});
  }
}

export { auth as runMcpAuthFlow };
