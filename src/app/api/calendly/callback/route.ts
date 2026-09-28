import { resolveAppOrigin } from "@/lib/app-url";
import { signOAuthState, verifyOAuthState, safeReturnPath } from "@/lib/oauth-state";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createCalendlyWebhookSubscription } from "@/lib/calendly";

/**
 * Standard OAuth2 authorization-code exchange against Calendly's token
 * endpoint (docs.calendly.com/api-docs — POST /oauth/token, form-encoded,
 * client_id + client_secret in the body, not Basic auth).
 */
export async function GET(req: NextRequest) {
  const stateRaw = req.nextUrl.searchParams.get("state");
  const code = req.nextUrl.searchParams.get("code");
  const oauthError = req.nextUrl.searchParams.get("error");

  if (!stateRaw) {
    return NextResponse.redirect(new URL("/settings?calendly_error=missing_state", req.url));
  }

  const state = verifyOAuthState<{ client_id: string; next?: string }>(stateRaw);
  if (!state) {
    return NextResponse.redirect(new URL("/settings?calendly_error=bad_state", req.url));
  }

  const returnTo = safeReturnPath(state.next);
  // eslint-disable-next-line no-console
  console.log(`[calendly] callback client=${state.client_id} code=${Boolean(code)} oauth_error=${oauthError ?? "-"}`);

  if (oauthError || !code) {
    return NextResponse.redirect(
      new URL(`${returnTo}?calendly_error=${encodeURIComponent(oauthError || "not_connected")}`, req.url)
    );
  }

  const clientId = process.env.CALENDLY_CLIENT_ID;
  const clientSecret = process.env.CALENDLY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(new URL(`${returnTo}?calendly_error=oauth_not_configured`, req.url));
  }

  const redirectUri = process.env.CALENDLY_OAUTH_REDIRECT_URI || new URL("/api/calendly/callback", resolveAppOrigin(req, { preferEnv: false })).toString();

  const tokenRes = await fetch("https://auth.calendly.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => "");
    return NextResponse.redirect(
      new URL(`${returnTo}?calendly_error=${encodeURIComponent(`token exchange failed: ${detail}`)}`, req.url)
    );
  }

  const tokenData = await tokenRes.json();
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = tokenData;

  if (!accessToken) {
    return NextResponse.redirect(new URL(`${returnTo}?calendly_error=no_access_token`, req.url));
  }

  const meRes = await fetch("https://api.calendly.com/users/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!meRes.ok) {
    const detail = await meRes.text().catch(() => "");
    return NextResponse.redirect(
      new URL(`${returnTo}?calendly_error=${encodeURIComponent(`could not read Calendly profile: ${detail}`)}`, req.url)
    );
  }

  const meData = await meRes.json();
  const resource = meData?.resource ?? {};

  const admin = createAdminClient();

  // One webhook subscription per client, scoped to their own org/user token
  // — a booking event delivered here can only ever belong to this client
  // (spec PHASE 8/9: never a global/shared Calendly connection). Best-effort:
  // the OAuth connection itself is still useful (booking link in emails)
  // even if this fails, so a subscription error doesn't block connecting.
  let webhookUri: string | null = null;
  let webhookSigningKey: string | null = null;
  const publicOrigin = resolveAppOrigin(req);
  if (resource.current_organization && resource.uri) {
    try {
      const sub = await createCalendlyWebhookSubscription({
        accessToken,
        organizationUri: resource.current_organization,
        userUri: resource.uri,
        callbackUrl: `${publicOrigin}/api/webhooks/calendly?client_id=${state.client_id}`,
      });
      webhookUri = sub.uri;
      webhookSigningKey = sub.signingKey;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Calendly webhook subscription failed for client ${state.client_id}:`, (err as Error).message);
    }
  }

  const { error: dbError } = await admin
    .from("clients")
    .update({
      calendly_access_token: accessToken,
      calendly_refresh_token: refreshToken ?? null,
      calendly_token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      calendly_user_uri: resource.uri ?? null,
      calendly_organization_uri: resource.current_organization ?? null,
      calendly_url: resource.scheduling_url ?? null,
      calendly_connected_at: new Date().toISOString(),
      calendly_webhook_uri: webhookUri,
      calendly_webhook_signing_key: webhookSigningKey,
    })
    .eq("id", state.client_id);

  if (dbError) {
    return NextResponse.redirect(
      new URL(`${returnTo}?calendly_error=${encodeURIComponent(dbError.message)}`, req.url)
    );
  }

  return NextResponse.redirect(
    new URL(`${returnTo}?calendly_connected=1${webhookUri ? "" : "&calendly_webhook_warning=1"}`, req.url)
  );
}
