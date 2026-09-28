import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";

/**
 * Powers the expandable sent-email history under each lead row in the Leads
 * table. RLS already scopes both `leads` and `outreach_log` to the caller's
 * own client_id, so the session-scoped client is enough here — no admin
 * client needed, unlike the mailbox routes.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const { data, error } = await supabase
    .from("outreach_log")
    .select("id, subject, body, touch_number, sent_at")
    .eq("lead_id", leadId)
    .order("sent_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ outreach: data ?? [] });
}
