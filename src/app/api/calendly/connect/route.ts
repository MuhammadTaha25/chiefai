import { resolveAppOrigin } from "@/lib/app-url";
import { signOAuthState, verifyOAuthState, safeReturnPath } from "@/lib/oauth-state";
import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";

export async function GET(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const clientId = process.env.CALENDLY_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "Calendly OAuth isn't configured yet (missing CALENDLY_CLIENT_ID)." }, { status: 400 });
  }

  const next = req.nextUrl.searchParams.get("next") || "/settings";

  // state travels inside our own redirect_uri (same pattern as
  // /api/zernio/connect) so the callback can attribute the connection to
  // this client without relying on a session cookie surviving the redirect.
  const state = signOAuthState({ client_id: client.id, next: safeReturnPath(next) });
  const redirectUri = process.env.CALENDLY_OAUTH_REDIRECT_URI || new URL("/api/calendly/callback", resolveAppOrigin(req, { preferEnv: false })).toString();

  const authorizeUrl = new URL("https://auth.calendly.com/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);

  return NextResponse.redirect(authorizeUrl.toString());
}
