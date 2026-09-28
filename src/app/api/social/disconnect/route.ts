import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { platform } = await req.json();
  if (!platform) {
    return NextResponse.json({ error: "platform is required" }, { status: 400 });
  }

  // Tenants have no UPDATE policy on these tables (a session-scoped update silently changed 0 rows while this
  // route still answered ok), so write with the admin client, strictly scoped to the session's client id.
  const admin = createAdminClient();
  await admin
    .from("social_automation_settings")
    .update({ automation_active: false, paused_at: new Date().toISOString() })
    .eq("client_id", client.id)
    .eq("platform", platform);

  const { data: changed, error } = await admin
    .from("social_connections")
    .update({ connection_status: "disconnected" })
    .eq("client_id", client.id)
    .eq("platform", platform)
    .select("id");

  if (error) {
    return NextResponse.json({ error: "Could not disconnect right now" }, { status: 500 });
  }
  if (!changed || changed.length === 0) {
    return NextResponse.json({ error: "No connected account found for that platform" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
