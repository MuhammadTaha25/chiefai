import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { isBusinessProfileComplete } from "@/lib/business-profile";
import { isValidTimeZone, parseTime } from "@/lib/social-schedule";

const PLATFORMS = ["instagram", "facebook", "linkedin", "tiktok", "youtube"];

export async function POST(req: NextRequest) {
  const { user, client, supabase } = await getCurrentClient();
  if (!user || !client) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { platform, activate, ...incoming } = body;
  // Whitelist: the browser may only change configuration. It must never set identity (client_id), the
  // activation/pause state (only `activate` below, behind the profile check, or /pause) or timestamps.
  const ALLOWED = [
    "posts_per_week", "image_posts_per_week", "carousel_posts_per_week", "video_posts_per_week", "stories_per_week",
    "content_preference", "approval_mode", "publish_mode", "auto_create_enabled", "auto_publish_enabled",
    "stories_enabled", "dm_enabled", "human_handoff_enabled", "comment_enabled", "lead_detection_enabled", "analytics_enabled", "post_time", "timezone",
  ];
  const settings: Record<string, unknown> = {};
  for (const k of ALLOWED) if (k in (incoming ?? {})) settings[k] = incoming[k];

  // Optional preferred posting time: empty/invalid means "use the default time".
  if ("post_time" in settings) settings.post_time = parseTime(settings.post_time as string) === null ? null : String(settings.post_time).trim().padStart(5, "0");
  if ("timezone" in settings) settings.timezone = isValidTimeZone(settings.timezone) ? settings.timezone : null;

  if (!PLATFORMS.includes(platform)) {
    return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
  }

  const { data: connection } = await supabase
    .from("social_connections")
    .select("connection_status")
    .eq("client_id", client.id)
    .eq("platform", platform)
    .maybeSingle();

  if (!connection || connection.connection_status !== "connected") {
    return NextResponse.json(
      { error: "Connect this account before configuring automation." },
      { status: 400 }
    );
  }

  if (activate) {
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
  }

  const patch: Record<string, unknown> = {
    client_id: client.id,
    platform,
    ...settings,
    updated_at: new Date().toISOString(),
  };

  if (activate) {
    patch.automation_active = true;
    patch.activated_at = new Date().toISOString();
    patch.paused_at = null;
  }

  const { data, error } = await supabase
    .from("social_automation_settings")
    .upsert(patch, { onConflict: "client_id,platform" })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, settings: data });
}
