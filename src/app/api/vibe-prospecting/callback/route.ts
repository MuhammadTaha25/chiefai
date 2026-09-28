import { resolveAppOrigin } from "@/lib/app-url";
import { NextRequest, NextResponse } from "next/server";
import {
  VibeProspectingMcpOAuthProvider,
  VIBE_PROSPECTING_MCP_CONFIG,
  getRedirectUri,
  runMcpAuthFlow,
} from "@/lib/vibe-prospecting-mcp";

/**
 * OAuth redirect target for the Vibe Prospecting (Explorium) connection.
 * Exchanges the authorization code for tokens and stores them in
 * leads_mcp_connection (id = "vibe_prospecting").
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const oauthError = req.nextUrl.searchParams.get("error");

  if (oauthError || !code) {
    return NextResponse.redirect(
      new URL(`/settings?vibe_prospecting_error=${encodeURIComponent(oauthError || "missing_code")}`, req.url)
    );
  }

  const redirectUri = getRedirectUri(resolveAppOrigin(req, { preferEnv: false }));
  const provider = new VibeProspectingMcpOAuthProvider(redirectUri);

  try {
    const result = await runMcpAuthFlow(provider, {
      serverUrl: VIBE_PROSPECTING_MCP_CONFIG.mcpUrl,
      authorizationCode: code,
    });
    if (result !== "AUTHORIZED") {
      return NextResponse.redirect(new URL("/settings?vibe_prospecting_error=not_authorized", req.url));
    }
    return NextResponse.redirect(new URL("/settings?vibe_prospecting_connected=1", req.url));
  } catch (err) {
    return NextResponse.redirect(
      new URL(`/settings?vibe_prospecting_error=${encodeURIComponent((err as Error).message)}`, req.url)
    );
  }
}
