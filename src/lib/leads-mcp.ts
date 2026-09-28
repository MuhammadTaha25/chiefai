import {
  McpOAuthProvider,
  callMcpTool,
  getRedirectUriFor,
  isMcpConnected,
  noCacheFetch,
  runMcpAuthFlow as runMcpAuthFlowRaw,
  type McpServiceConfig,
} from "@/lib/mcp-oauth-connection";

/**
 * Frontage Leads (frontageleads.com/mcp) — connected once with the account
 * owner's own credentials (RFC 7591 dynamic client registration + OAuth 2.1
 * + PKCE), so every subsequent lead search across all of this app's clients
 * draws on that one account's credits. See
 * supabase/add_leads_mcp_connection_table.sql for the row this reads/writes.
 */
export const LEADS_MCP_CONFIG: McpServiceConfig = {
  connectionId: "default",
  mcpUrl: "https://frontageleads.com/mcp",
  serviceLabel: "Frontage Leads",
  scope: "leads.read leads.export",
  redirectEnvVar: "LEADS_MCP_REDIRECT_URI",
  redirectPath: "/api/leads/callback",
};

export const LEADS_MCP_URL = LEADS_MCP_CONFIG.mcpUrl;

export class LeadsMcpOAuthProvider extends McpOAuthProvider {
  constructor(redirectUri: string) {
    super(LEADS_MCP_CONFIG, redirectUri);
  }
}

export function getRedirectUri(origin: string) {
  return getRedirectUriFor(LEADS_MCP_CONFIG, origin);
}

export function isLeadsMcpConnected() {
  return isMcpConnected(LEADS_MCP_CONFIG);
}

export function callLeadsMcpTool<T = unknown>(toolName: string, args: Record<string, unknown>, redirectUri: string) {
  return callMcpTool<T>(LEADS_MCP_CONFIG, toolName, args, redirectUri);
}

export function runMcpAuthFlow(
  provider: Parameters<typeof runMcpAuthFlowRaw>[0],
  options: Parameters<typeof runMcpAuthFlowRaw>[1]
) {
  return runMcpAuthFlowRaw(provider, { ...options, fetchFn: noCacheFetch });
}
