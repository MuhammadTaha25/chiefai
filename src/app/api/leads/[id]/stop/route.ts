import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Client-triggered manual stop (spec §6/PHASE 6: MANUALLY_STOPPED). Cancels
 * any pending follow-up immediately and marks the lead so the daily sender
 * and future monthly campaigns never select it again (both already filter
 * on `manually_stopped = false`).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await params;
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data: lead } = await supabase
    .from("leads")
    .select("id")
    .eq("id", leadId)
    .eq("client_id", client.id)
    .maybeSingle();

  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("leads")
    .update({
      manually_stopped: true,
      manually_stopped_at: new Date().toISOString(),
      next_follow_up_at: null,
    })
    .eq("id", leadId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
