import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";

// The two Zernio key groups this app uses — instagram/tiktok share one
// account, facebook/linkedin/youtube share the other.
const API_KEY_BY_PLATFORM: Record<string, string | undefined> = {
  instagram: process.env.ZERNIO_API_KEY_TIKTOK_INSTAGRAM,
  facebook: process.env.ZERNIO_API_KEY_GOOGLE_META,
};

/**
 * Instagram/Facebook DM automation does nothing if the account owner hasn't
 * granted messaging access — this is a per-account setting Meta added, not
 * something any platform (including Zernio) can enable via API. We can only
 * detect it and guide the client through fixing it.
 *
 * How it is detected matters: the check used to be
 * `Boolean(account.xCapabilities.inbox)`, which is FALSE for every account we
 * have ever connected — including ones whose permissions already include
 * instagram_business_manage_messages / pages_messaging and which sync DMs
 * fine. That made the "DM replies need one more step" warning permanent and
 * unfixable, so the real signal is used instead:
 *
 *   1. the messaging permission Meta actually requires is present, and
 *   2. Zernio has not recorded an inbox auth error / disconnection.
 *
 * `xCapabilities.inbox` is still reported (informational) but no longer decides.
 */
export async function POST(req: NextRequest) {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { platform } = await req.json();
  if (platform !== "instagram" && platform !== "facebook") {
    return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
  }

  const { data: connection } = await supabase
    .from("social_connections")
    .select("zernio_account_id, connection_status")
    .eq("client_id", client.id)
    .eq("platform", platform)
    .maybeSingle();

  if (!connection || connection.connection_status !== "connected" || !connection.zernio_account_id) {
    return NextResponse.json({ error: "Not connected yet." }, { status: 400 });
  }

  const apiKey = API_KEY_BY_PLATFORM[platform];
  const res = await fetch(`${process.env.ZERNIO_BASE_URL}/accounts`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    return NextResponse.json({ error: `Could not check with Zernio (${res.status}).` }, { status: 502 });
  }

  const data = await res.json();
  const account = (data?.accounts ?? []).find(
    (a: Record<string, unknown>) => a._id === connection.zernio_account_id
  ) as
    | {
        permissions?: string[];
        needsReconnection?: boolean;
        inboxAuthErrorAt?: string | null;
        xCapabilities?: { inbox?: boolean };
      }
    | undefined;

  const requiredPermission =
    platform === "instagram" ? "instagram_business_manage_messages" : "pages_messaging";
  const permissions = Array.isArray(account?.permissions) ? account.permissions : [];
  const hasMessagingPermission = permissions.includes(requiredPermission);
  const authHealthy = !account?.needsReconnection && !account?.inboxAuthErrorAt;
  const inboxEnabled = hasMessagingPermission && authHealthy;

  const reason = inboxEnabled
    ? null
    : !hasMessagingPermission
      ? `This account hasn't granted the "${requiredPermission}" permission yet. Reconnect the ${platform} account and accept the messaging permission when Meta asks.`
      : "Meta or Zernio has flagged this account's messaging access. Reconnect the account to refresh it.";

  // Written with the ADMIN client on purpose: social_connections only has a
  // SELECT policy (supabase/fix_all_client_rls.sql), so a session-scoped update
  // matches 0 rows and returns no error — the recheck used to report a new
  // value it had never saved. The client id is resolved server-side above.
  const admin = createAdminClient();
  const { error: writeError } = await admin
    .from("social_connections")
    .update({ inbox_enabled: inboxEnabled, inbox_checked_at: new Date().toISOString() })
    .eq("client_id", client.id)
    .eq("platform", platform);

  if (writeError) {
    return NextResponse.json({ error: `Could not save the result: ${writeError.message}` }, { status: 500 });
  }

  return NextResponse.json({
    inboxEnabled,
    reason,
    // Informational: Zernio's own capability flag, which does not track the
    // Meta messaging permission and is false on working accounts.
    zernioInboxCapability: account?.xCapabilities?.inbox ?? null,
    permissions,
  });
}
