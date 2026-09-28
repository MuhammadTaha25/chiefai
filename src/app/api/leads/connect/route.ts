import { resolveAppOrigin } from "@/lib/app-url";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { LeadsMcpOAuthProvider, LEADS_MCP_URL, getRedirectUri, runMcpAuthFlow } from "@/lib/leads-mcp";

/**
 * Starts (or completes, if already authorized) the OAuth connection to
 * Frontage Leads. This is the account owner connecting their own Frontage
 * Leads account once — not a per-client connection — so it just requires
 * being logged in, same gate as any other settings page action.
 */
export async function GET(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const redirectUri = getRedirectUri(resolveAppOrigin(req, { preferEnv: false }));
  const provider = new LeadsMcpOAuthProvider(redirectUri);

  try {
    const result = await runMcpAuthFlow(provider, { serverUrl: LEADS_MCP_URL });

    if (result === "AUTHORIZED") {
      return NextResponse.redirect(new URL("/settings?leads_connected=1", req.url));
    }

    if (provider.capturedAuthorizationUrl) {
      return NextResponse.redirect(provider.capturedAuthorizationUrl.toString());
    }

    return NextResponse.redirect(
      new URL("/settings?leads_error=no_authorization_url", req.url)
    );
  } catch (err) {
    return NextResponse.redirect(
      new URL(`/settings?leads_error=${encodeURIComponent((err as Error).message)}`, req.url)
    );
  }
}
