import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { runFollowUpBatch } from "@/lib/follow-ups";

/**
 * Follow-ups for leads whose initial email was sent and who have not replied, bounced, unsubscribed or booked.
 * Meant to run on a schedule (Vercel Cron -> Authorization: Bearer $CRON_SECRET), but also callable by an
 * authenticated client to trigger it manually for just their own leads.
 */
async function runFollowUps(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const isCron = Boolean(cronSecret) && authHeader === `Bearer ${cronSecret}`;

  let clientIdFilter: string | null = null;
  if (!isCron) {
    const { user, client } = await getCurrentClient();
    if (!user || !client) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    clientIdFilter = client.id;
  }

  // First-deploy safety: the scheduled (cron) run only sends when the owner has explicitly enabled it, so
  // follow-ups already scheduled in the database cannot fire the moment the app is deployed.
  if (isCron && process.env.FOLLOW_UP_CRON_ENABLED !== "true") {
    return NextResponse.json({ ok: true, paused: true, reason: "FOLLOW_UP_CRON_ENABLED is not \"true\"" });
  }

  const out = await runFollowUpBatch({ clientIdFilter, isCron });
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 500 });
  return NextResponse.json({ ok: true, processed: out.results.length, results: out.results });
}

export const GET = runFollowUps;
export const POST = runFollowUps;
