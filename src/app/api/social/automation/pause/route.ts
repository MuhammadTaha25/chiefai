import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { isBusinessProfileComplete } from "@/lib/business-profile";

export async function POST(req: NextRequest) {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { platform, resume } = await req.json();

  // Resuming is activation, so it must clear the SAME gate that
  // /api/social/automation enforces before activating: without this, the
  // master switch could turn cron posting and webhook auto-replies back on for
  // a client whose Business Profile was never completed.
  if (resume) {
    const { data: profile } = await supabase
      .from("client_social_profile")
      .select("*")
      .eq("client_id", client.id)
      .maybeSingle();

    if (!isBusinessProfileComplete(client, profile)) {
      return NextResponse.json(
        { error: "Complete your Business Profile before activating automation." },
        { status: 400 }
      );
    }

    if (platform) {
      const { data: connection } = await supabase
        .from("social_connections")
        .select("connection_status")
        .eq("client_id", client.id)
        .eq("platform", platform)
        .maybeSingle();
      if (!connection || connection.connection_status !== "connected") {
        return NextResponse.json({ error: "Connect this account before activating automation." }, { status: 400 });
      }
    }
  }

  const query = supabase
    .from("social_automation_settings")
    .update({
      automation_active: !!resume,
      paused_at: resume ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("client_id", client.id);

  const { error } = platform ? await query.eq("platform", platform) : await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
