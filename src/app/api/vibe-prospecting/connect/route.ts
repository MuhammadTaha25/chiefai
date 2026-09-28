import { resolveAppOrigin } from "@/lib/app-url";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import {
  VibeProspectingMcpOAuthProvider,
  VIBE_PROSPECTING_MCP_CONFIG,
  getRedirectUri,
  runMcpAuthFlow,
} from "@/lib/vibe-prospecting-mcp";

/**
 * Starts (or completes, if already authorized) the OAuth connection to
 * Vibe Prospecting (Explorium's MCP server). Account-owner-level connection,
 * same as /api/leads/connect — just requires being logged in.
 */
export async function GET(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const redirectUri = getRedirectUri(resolveAppOrigin(req, { preferEnv: false }));
  const provider = new VibeProspectingMcpOAuthProvider(redirectUri);

  try {
    const result = await runMcpAuthFlow(provider, { serverUrl: VIBE_PROSPECTING_MCP_CONFIG.mcpUrl });

    if (result === "AUTHORIZED") {
      return NextResponse.redirect(new URL("/settings?vibe_prospecting_connected=1", req.url));
    }

    if (provider.capturedAuthorizationUrl) {
      return NextResponse.redirect(provider.capturedAuthorizationUrl.toString());
    }

    return NextResponse.redirect(new URL("/settings?vibe_prospecting_error=no_authorization_url", req.url));
  } catch (err) {
    return NextResponse.redirect(
      new URL(`/settings?vibe_prospecting_error=${encodeURIComponent((err as Error).message)}`, req.url)
    );
  }
}
