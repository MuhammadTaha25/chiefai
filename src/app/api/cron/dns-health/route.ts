import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentClient } from "@/lib/get-current-client";
import { runDnsHealth } from "@/lib/dns-health";
import { runPlatformHealth } from "@/lib/platform-health";
import { resolveAppOrigin } from "@/lib/app-url";

/**
 * Re-checks SPF/DKIM/MX/CNAME/DMARC for every active domain and stores the per-record result on `domains`.
 * Cron (Authorization: Bearer $CRON_SECRET) checks all domains; a signed-in client checks only their own.
 * Detect and report only: never writes DNS.
 */
async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const isCron = Boolean(secret) && req.headers.get("authorization") === `Bearer ${secret}`;
  let clientId: string | undefined;
  if (!isCron) {
    const { user, client } = await getCurrentClient();
    if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    clientId = client.id;
  }
  const admin = createAdminClient();
  const dns = await runDnsHealth(admin, clientId);
  // Platform-wide checks (inbound route + duplicate mailbox addresses) are for the scheduled run only: they span every client.
  const platform = isCron ? await runPlatformHealth(admin, `${resolveAppOrigin(req)}/api/webhooks/mailgun`) : undefined;
  return NextResponse.json({ ok: true, ...dns, ...(platform ? { platform } : {}) });
}
export const GET = handle;
export const POST = handle;
