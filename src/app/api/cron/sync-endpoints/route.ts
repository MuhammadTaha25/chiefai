import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentClient } from "@/lib/get-current-client";
import { isCronRequest } from "@/lib/webhook-security";
import { resolveAppOrigin } from "@/lib/app-url";
import { syncPublicEndpoints, checkBridgeHealth } from "@/lib/public-endpoints";
import { logEvent } from "@/lib/log-event";

/**
 * Re-point the whole bridge at the current public origin.
 *
 * Run this after the tunnel changes (or on a schedule — it is idempotent and
 * leaves anything already correct alone). It fixes the two things that silently
 * break when a tunnel restarts:
 *
 *   - Zernio webhook subscriptions, which would otherwise keep POSTing comment
 *     and DM events to a dead origin;
 *   - every Twilio number we bought, whose VoiceUrl would otherwise point at
 *     nothing.
 *
 * Auth: cron (CRON_SECRET), or an authenticated session so the client can press
 * a button to repair their own bridge. In every case the origin comes from
 * server-side config — the request may only NARROW it, never point it elsewhere
 * (an attacker-chosen origin would let them redirect our webhooks and calls).
 */

async function run(req: NextRequest) {
  const admin = createAdminClient();

  const isCron = isCronRequest(req.headers.get("authorization"));
  if (!isCron) {
    const { user } = await getCurrentClient();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // The origin is whatever the app is publicly reachable at, decided server-side.
  const origin = resolveAppOrigin({ nextUrl: { origin: new URL(req.url).origin } });

  const health = await checkBridgeHealth(origin);
  const result = await syncPublicEndpoints(admin, origin);

  const changed =
    result.zernio.some((c) => c.action === "updated") ||
    result.twilio.some((c) => c.action === "updated");

  logEvent("bridge.sync", {
    result: changed ? "repaired" : "unchanged",
    origin,
    reachable: health.reachable,
    zernio_updated: result.zernio.filter((c) => c.action === "updated").length,
    twilio_updated: result.twilio.filter((c) => c.action === "updated").length,
    failures: result.zernio.concat(result.twilio).filter((c) => c.action === "failed").length,
  });

  return NextResponse.json({ ok: true, health, ...result });
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
