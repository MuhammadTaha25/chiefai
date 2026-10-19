import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 30;

/**
 * Clears temporary bounce flags for leads whose retry window has passed.
 * When Mailgun reports a "temporary" / "failed" event (server error, full mailbox),
 * we set bounce_type = 'temporary' and bounce_retry_after = now() + 24h.
 *
 * Follow-ups skip a lead until its retry time passes; this cron then clears the flag (every 30 minutes).
 *
 * Run as: GET /api/cron/bounce-retry
 *         Authorization: Bearer <CRON_SECRET>
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  // Find leads with temporary bounces whose retry window has passed
  const { data: readyLeads, error: fetchError } = await admin
    .from("leads")
    .select("id, client_id, email, name, bounce_retry_after")
    .eq("bounce_type", "temporary")
    .eq("email_bounced", false) // permanent bounces are excluded
    .lte("bounce_retry_after", now)
    .not("email", "is", null)
    .limit(50);

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  const results: { leadId: string; cleared: boolean; error?: string }[] = [];

  for (const lead of readyLeads ?? []) {
    try {
      const { error: updateError } = await admin
        .from("leads")
        .update({
          bounce_type: null,
          bounce_retry_after: null,
          // next_follow_up_at is left exactly as it was: the follow-up flow holds a soft-bounced lead until its
          // retry time, then sends when the follow-up is due. Never pulled forward, never resurrected.
        })
        .eq("id", lead.id)
        .eq("bounce_type", "temporary") // atomic: only if still temporary
        .lte("bounce_retry_after", now); // and still past its retry window

      results.push({ leadId: lead.id, cleared: !updateError, error: updateError?.message });
    } catch (err) {
      results.push({ leadId: lead.id, cleared: false, error: String(err) });
    }
  }

  const cleared = results.filter((r) => r.cleared).length;
  return NextResponse.json({ ok: true, processed: results.length, cleared, results });
}
