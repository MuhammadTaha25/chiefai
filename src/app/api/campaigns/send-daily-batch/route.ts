import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentClient } from "@/lib/get-current-client";
import { sendBatchForClient } from "@/lib/send-batch";

// Sends are spaced out with sleeps, so this run needs a long function budget on Vercel.
export const maxDuration = 300;

/**
 * POST with `Authorization: Bearer $CRON_SECRET` runs the batch for every
 * client with an active campaign this month (the real daily scheduler).
 * Called without that header, it resolves the authenticated client
 * server-side and runs only their own batch — for manual testing/triggering
 * from the dashboard, never trusting a client_id from the request body.
 */
export async function GET(req: NextRequest) {
  // Vercel Cron invokes scheduled paths with GET.
  return POST(req);
}

export async function POST(req: NextRequest) {
  const admin = createAdminClient();
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const isCron = Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;

  let clientIds: string[];
  if (isCron) {
    const campaignMonth = (() => {
      const now = new Date();
      return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    })();
    const { data: activeCampaigns } = await admin
      .from("campaigns")
      .select("client_id")
      .eq("campaign_month", campaignMonth)
      .eq("status", "active");
    clientIds = [...new Set((activeCampaigns ?? []).map((c) => c.client_id))];
  } else {
    const { user, client } = await getCurrentClient();
    if (!user || !client) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    clientIds = [client.id];
  }

  const results = [];
  for (const clientId of clientIds) {
    results.push(await sendBatchForClient(clientId));
  }

  return NextResponse.json({ ok: true, processed: results.length, results });
}
