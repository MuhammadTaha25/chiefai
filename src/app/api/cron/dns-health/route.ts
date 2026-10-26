import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentClient } from "@/lib/get-current-client";
import { runDnsHealth } from "@/lib/dns-health";
import { runPlatformHealth } from "@/lib/platform-health";
import { resolveAppOrigin } from "@/lib/app-url";
import { buildPlatformAlert } from "@/lib/platform-alert-core";
import { mailgunDomainForAddress, sendMail } from "@/lib/mailgun";

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
  // Alert mail (scheduled run only). Off unless both PLATFORM_ALERT_TO and PLATFORM_ALERT_FROM are set; the FROM address
  // must be on a verified Mailgun domain. A failed alert never fails the health check.
  let alerted = false;
  const to = process.env.PLATFORM_ALERT_TO?.trim();
  const from = process.env.PLATFORM_ALERT_FROM?.trim();
  const alert = isCron ? buildPlatformAlert({ sendingBroken: dns.sendingBroken, errors: dns.errors, platform }) : null;
  if (alert && to && from) {
    try {
      await sendMail({ domain: mailgunDomainForAddress(from), from, to, subject: alert.subject, text: alert.text });
      alerted = true;
    } catch (e) {
      console.error(`[dns-health] alert mail failed: ${(e as Error).message}`);
    }
  }
  return NextResponse.json({ ok: true, ...dns, ...(platform ? { platform } : {}), ...(alert ? { alert: { needed: true, sent: alerted } } : {}) });
}
export const GET = handle;
export const POST = handle;
