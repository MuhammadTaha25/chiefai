import { after } from "next/server";
import { INITIAL_DELAY_MINUTES, ensureAutomationDefaults, runInitialCycleAfterDelay, scheduleInitialRun } from "@/lib/social-initial";

import { signOAuthState, verifyOAuthState, safeReturnPath } from "@/lib/oauth-state";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// The validation cycle runs inside this request's lifetime (see below); video rendering is slow.
export const maxDuration = 300; // Hobby-plan ceiling. A Veo video can take longer, so video needs the Pro plan (raise this to 800 there).

/**
 * Zernio appends its own query params (connected/accountId/profileId/username
 * or error) onto whatever redirect_url we gave it — our state param survives
 * because it's baked into that same URL, not passed through by Zernio.
 */
export async function GET(req: NextRequest) {
  const stateRaw = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");
  const connected = req.nextUrl.searchParams.get("connected");
  const accountId = req.nextUrl.searchParams.get("accountId");
  const profileId = req.nextUrl.searchParams.get("profileId");

  if (!stateRaw) {
    return NextResponse.redirect(new URL("/settings?zernio_error=missing_state", req.url));
  }

  // Signed + expiring: a forged state (attacker's provider account + a victim's
  // client_id) is rejected here instead of overwriting the victim's connection.
  const state = verifyOAuthState<{ client_id: string; platform: string; next?: string }>(stateRaw);
  if (!state) {
    return NextResponse.redirect(new URL("/settings?zernio_error=bad_state", req.url));
  }

  const returnTo = safeReturnPath(state.next);

  if (error || !connected || !accountId) {
    return NextResponse.redirect(
      new URL(`${returnTo}?zernio_error=${encodeURIComponent(error || "not_connected")}`, req.url)
    );
  }

  const admin = createAdminClient();

  // The signed state proves WHICH client started the flow, but accountId/profileId arrive as plain query params
  // anyone can edit. Only save the connection if Zernio itself says this account lives in THIS client's profile,
  // otherwise a user could attach someone else's connected account to their own tenant.
  const metaGroup = ["facebook", "linkedin", "youtube", "google_ads", "facebook_ads"].includes(state.platform);
  const apiKey = metaGroup ? process.env.ZERNIO_API_KEY_GOOGLE_META : process.env.ZERNIO_API_KEY_TIKTOK_INSTAGRAM;
  const { data: ownRow } = await admin
    .from("clients")
    .select("zernio_profile_id, zernio_profile_id_meta")
    .eq("id", state.client_id)
    .maybeSingle<{ zernio_profile_id: string | null; zernio_profile_id_meta: string | null }>();
  const ownProfileId = metaGroup ? ownRow?.zernio_profile_id_meta : ownRow?.zernio_profile_id;
  let verifiedProfileId: string | null = null;
  try {
    const res = await fetch(`${process.env.ZERNIO_BASE_URL}/accounts`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.ok) {
      const data = await res.json();
      const acct = (data?.accounts ?? []).find((a: Record<string, unknown>) => a._id === accountId) as { profileId?: { _id?: string } | string } | undefined;
      const acctProfile = typeof acct?.profileId === "string" ? acct.profileId : acct?.profileId?._id;
      if (acct && ownProfileId && acctProfile === ownProfileId) verifiedProfileId = acctProfile;
    }
  } catch {
    // fail closed below
  }
  if (!verifiedProfileId) {
    return NextResponse.redirect(new URL(`${returnTo}?zernio_error=account_not_verified`, req.url));
  }

  const { error: dbError } = await admin.from("social_connections").upsert(
    {
      client_id: state.client_id,
      platform: state.platform,
      zernio_account_id: accountId,
      zernio_profile_id: verifiedProfileId,
      connection_status: "connected",
      connected_at: new Date().toISOString(),
    },
    { onConflict: "client_id,platform" }
  );

  if (dbError) {
    return NextResponse.redirect(
      new URL(`${returnTo}?zernio_error=save_failed`, req.url)
    );
  }

  // Google Ads campaign creation needs the actual Google customer id
  // (Zernio's "adAccountId"), not just Zernio's own accountId — look it up
  // from Zernio's account list and cache it on the client.
  if (state.platform === "google_ads" && accountId) {
    try {
      const apiKey = process.env.ZERNIO_API_KEY_GOOGLE_META;
      const accountsRes = await fetch(`${process.env.ZERNIO_BASE_URL}/accounts`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (accountsRes.ok) {
        const accountsData = await accountsRes.json();
        const match = (accountsData?.accounts ?? []).find(
          (a: Record<string, unknown>) => a._id === accountId || a.accountId === accountId
        );
        const customerId =
          (match?.adAccountId as string | undefined) ??
          (match?.customerId as string | undefined) ??
          (match?.customer_id as string | undefined);
        if (customerId) {
          await admin.from("clients").update({ google_ads_customer_id: customerId }).eq("id", state.client_id);
        }
      }
    } catch {
      // Non-fatal — the connection itself succeeded; the customer id can be
      // resolved later before a campaign actually needs it.
    }
  }

  // Instagram/Facebook DM automation does nothing if the account owner
  // hasn't turned on "message access for connected apps" inside Instagram
  // itself — a per-account Instagram setting Meta added that no platform
  // (Zernio included) can flip via API. Check it now so the UI can guide the
  // client through it instead of automation quietly failing.
  if ((state.platform === "instagram" || state.platform === "facebook") && accountId) {
    try {
      const apiKey =
        state.platform === "instagram"
          ? process.env.ZERNIO_API_KEY_TIKTOK_INSTAGRAM
          : process.env.ZERNIO_API_KEY_GOOGLE_META;
      const accountsRes = await fetch(`${process.env.ZERNIO_BASE_URL}/accounts`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (accountsRes.ok) {
        const accountsData = await accountsRes.json();
        const match = (accountsData?.accounts ?? []).find(
          (a: Record<string, unknown>) => a._id === accountId
        );
        await admin
          .from("social_connections")
          .update({
            inbox_enabled: Boolean((match as { xCapabilities?: { inbox?: boolean } })?.xCapabilities?.inbox),
            inbox_checked_at: new Date().toISOString(),
          })
          .eq("client_id", state.client_id)
          .eq("platform", state.platform);
      }
    } catch {
      // Non-fatal — checked again on demand from the Social page.
    }
  }

  // Every Facebook/Instagram connection (including a reconnect after a disconnect): queue the validation
  // cycle (image + video, each with a story) ~5 minutes from now.
  if (state.platform === "instagram" || state.platform === "facebook") {
    // Comment/DM replies and content automation must work as soon as the account is connected.
    await ensureAutomationDefaults(admin, state.client_id, state.platform);
    const isNew = await scheduleInitialRun(admin, state.client_id, accountId);
    // Run it from here so it does not depend on a cron being active: wait ~5 minutes when this is the
    // first connection, or start straight away for a run that was queued earlier and never processed.
    // The cron route is the fallback; both go through the same claim, so a cycle can never run twice.
    after(() => runInitialCycleAfterDelay(admin, state.client_id, isNew ? INITIAL_DELAY_MINUTES : 0));
  }

  return NextResponse.redirect(new URL(`${returnTo}?zernio_connected=${state.platform}`, req.url));
}
