import { resolveAppOrigin } from "@/lib/app-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { signOAuthState, verifyOAuthState, safeReturnPath } from "@/lib/oauth-state";
import { NextRequest, NextResponse } from "next/server";
import { logEvent } from "@/lib/log-event";
import { getCurrentClient } from "@/lib/get-current-client";

const VALID_PLATFORMS = [
  "instagram",
  "facebook",
  "linkedin",
  "tiktok",
  "youtube",
  "google_ads",
  "facebook_ads",
  "instagram_ads",
] as const;
type Platform = (typeof VALID_PLATFORMS)[number];

// The free Zernio plan splits access across two API keys, and each key is its
// own separate Zernio account — a profile created under one key doesn't
// exist under the other, so profile id must be tracked per key group too.
type KeyGroup = "google_meta" | "tiktok_instagram";

const KEY_GROUP_BY_PLATFORM: Record<Platform, KeyGroup> = {
  facebook: "google_meta",
  linkedin: "google_meta",
  youtube: "google_meta",
  google_ads: "google_meta",
  facebook_ads: "google_meta",
  instagram: "tiktok_instagram",
  tiktok: "tiktok_instagram",
  instagram_ads: "tiktok_instagram",
};

const API_KEY_BY_GROUP: Record<KeyGroup, string | undefined> = {
  google_meta: process.env.ZERNIO_API_KEY_GOOGLE_META,
  tiktok_instagram: process.env.ZERNIO_API_KEY_TIKTOK_INSTAGRAM,
};

// clients.zernio_profile_id holds the tiktok/instagram-group profile (the
// original column, predating the second key); zernio_profile_id_meta holds
// the google/meta-group one.
const PROFILE_COLUMN_BY_GROUP: Record<KeyGroup, "zernio_profile_id" | "zernio_profile_id_meta"> = {
  tiktok_instagram: "zernio_profile_id",
  google_meta: "zernio_profile_id_meta",
};

// Zernio's ads-only connect flows live at a different path than the organic
// social ones (confirmed against docs.zernio.com: /v1/connect/{platform}/ads
// for Google Ads and Meta Ads, vs /v1/connect/{platform} for everything else).
// facebook_ads/instagram_ads are also kept as separate platform values (not
// reusing "facebook"/"instagram") so an ads connection never overwrites the
// organic social_connections row for the same client — they used to share
// one row via upsert(onConflict: client_id,platform), which is what caused
// the ads connect flow to silently fall back through the organic path.
const ADS_CONNECT_SUFFIX: Partial<Record<Platform, string>> = {
  google_ads: "googleads/ads",
  facebook_ads: "facebook/ads",
  instagram_ads: "instagram/ads",
};

/**
 * Zernio's 4xx/5xx bodies are JSON with a machine-readable `code` and a
 * human-readable `error` (see zernio.com/openapi.json). Surface that message so
 * a plan-limit (402) or auth (401) failure tells the user what to actually do,
 * instead of a generic "try again shortly".
 */
function zernioErrorMessage(raw: string): string {
  try {
    const data = JSON.parse(raw) as { error?: unknown; code?: unknown };
    if (typeof data.error === "string" && data.error) {
      const code = typeof data.code === "string" && data.code ? ` (${data.code})` : "";
      return (data.error + code).slice(0, 200);
    }
  } catch {
    // non-JSON body — fall through to the raw text
  }
  return raw.slice(0, 200);
}

export async function GET(req: NextRequest) {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const platform = req.nextUrl.searchParams.get("platform") as Platform | null;
  if (!platform || !VALID_PLATFORMS.includes(platform)) {
    return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
  }

  const keyGroup = KEY_GROUP_BY_PLATFORM[platform];
  const apiKey = API_KEY_BY_GROUP[keyGroup];
  if (!apiKey) {
    return NextResponse.json({ error: "This platform isn't available on the current plan yet." }, { status: 400 });
  }

  const next = req.nextUrl.searchParams.get("next") || "/settings";
  const profileColumn = PROFILE_COLUMN_BY_GROUP[keyGroup];

  // Zernio scopes connected accounts under a "profile" — create one lazily on
  // first connect (per key group) and remember it, instead of requiring it
  // at onboarding.
  let profileId: string | null = client[profileColumn];
  if (!profileId) {
    const profileRes = await fetch(`${process.env.ZERNIO_BASE_URL}/profiles`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: client.company_name || `client-${client.id}` }),
    });

    if (!profileRes.ok) {
      const detail = await profileRes.text().catch(() => "");

      // A same-named profile can already exist under this key group (e.g. a
      // retried connect before the profile id got persisted) — reuse it
      // instead of failing.
      if (profileRes.status === 409) {
        try {
          profileId = JSON.parse(detail)?.details?.existingProfileId ?? null;
        } catch {
          // fall through to the error response below
        }
      }

      if (!profileId) {
        const message = zernioErrorMessage(detail);
        logEvent("zernio.profile_failed", { client_id: client.id, status: profileRes.status, error: message });
        return NextResponse.json(
          { error: message || "Could not set up your social profile right now. Please try again shortly." },
          { status: 502 }
        );
      }
    } else {
      const profileData = await profileRes.json();
      profileId = profileData?.profile?._id;
    }
    if (!profileId) {
      return NextResponse.json({ error: "Zernio did not return a profile id." }, { status: 502 });
    }

    await createAdminClient().from("clients").update({ [profileColumn]: profileId }).eq("id", client.id);
  }

  // state travels inside our own redirect_url (Zernio doesn't pass through a
  // generic state param) so the callback can attribute the connection
  // without trusting anything Zernio/the platform sends back.
  const state = signOAuthState({ client_id: client.id, platform, next: safeReturnPath(next) });
  const redirectUrl = new URL("/api/zernio/callback", resolveAppOrigin(req, { preferEnv: false }));
  redirectUrl.searchParams.set("state", state);

  const connectPath = ADS_CONNECT_SUFFIX[platform] ?? platform;
  const connectRes = await fetch(
    `${process.env.ZERNIO_BASE_URL}/connect/${connectPath}?profileId=${encodeURIComponent(
      profileId
    )}&redirect_url=${encodeURIComponent(redirectUrl.toString())}`,
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );

  if (!connectRes.ok) {
    const detail = await connectRes.text().catch(() => "");
    const message = zernioErrorMessage(detail);
    logEvent("zernio.connect_failed", { client_id: client.id, platform, status: connectRes.status, error: message });
    return NextResponse.json(
      { error: message || "Could not start the connection right now. Please try again shortly." },
      { status: 502 }
    );
  }

  const connectData = await connectRes.json();

  // Already-connected profiles get a direct result instead of an authUrl —
  // route straight back through the callback so the connection gets saved.
  if (connectData?.alreadyConnected) {
    const callbackUrl = new URL(redirectUrl);
    callbackUrl.searchParams.set("connected", platform);
    if (connectData.accountId) callbackUrl.searchParams.set("accountId", connectData.accountId);
    if (connectData.username) callbackUrl.searchParams.set("username", connectData.username);
    return NextResponse.redirect(callbackUrl.toString());
  }

  if (!connectData?.authUrl) {
    return NextResponse.json({ error: "Zernio did not return an authorization URL." }, { status: 502 });
  }

  return NextResponse.redirect(connectData.authUrl);
}
