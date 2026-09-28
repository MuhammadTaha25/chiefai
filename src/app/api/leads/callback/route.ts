import { resolveAppOrigin } from "@/lib/app-url";
import { NextRequest, NextResponse } from "next/server";
import { LeadsMcpOAuthProvider, LEADS_MCP_URL, getRedirectUri, runMcpAuthFlow } from "@/lib/leads-mcp";

/**
 * OAuth redirect target for the Frontage Leads connection (registered as
 * this app's redirect_uri during dynamic client registration in
 * /api/leads/connect). Exchanges the authorization code for tokens and
 * stores them in leads_mcp_connection.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const oauthError = req.nextUrl.searchParams.get("error");

  if (oauthError || !code) {
    return NextResponse.redirect(
      new URL(`/settings?leads_error=${encodeURIComponent(oauthError || "missing_code")}`, req.url)
    );
  }

  const redirectUri = getRedirectUri(resolveAppOrigin(req, { preferEnv: false }));
  const provider = new LeadsMcpOAuthProvider(redirectUri);

  try {
    const result = await runMcpAuthFlow(provider, { serverUrl: LEADS_MCP_URL, authorizationCode: code });
    if (result !== "AUTHORIZED") {
      return NextResponse.redirect(new URL("/settings?leads_error=not_authorized", req.url));
    }
    return NextResponse.redirect(new URL("/settings?leads_connected=1", req.url));
  } catch (err) {
    return NextResponse.redirect(
      new URL(`/settings?leads_error=${encodeURIComponent((err as Error).message)}`, req.url)
    );
  }
}
