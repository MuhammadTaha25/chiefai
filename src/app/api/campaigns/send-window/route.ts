import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseClockMinutes } from "@/lib/send-window";
import { isValidTimeZone } from "@/lib/social-schedule";

/** The client's own outreach window (start and end) and timezone. Empty start and end mean the default 08:00-24:00, in the client's timezone. */
export async function GET() {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data } = await createAdminClient()
    .from("clients")
    .select("outreach_send_start, outreach_send_end, timezone")
    .eq("id", client.id)
    .maybeSingle<{ outreach_send_start: string | null; outreach_send_end: string | null; timezone: string | null }>();

  return NextResponse.json({
    ok: true,
    start: data?.outreach_send_start?.slice(0, 5) ?? null,
    end: data?.outreach_send_end?.slice(0, 5) ?? null,
    timezone: data?.timezone ?? null,
    default: { start: "08:00", end: "24:00" },
  });
}

export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  const startRaw = typeof body.start === "string" ? body.start.trim() : "";
  const endRaw = typeof body.end === "string" ? body.end.trim() : "";

  if (!startRaw && !endRaw) {
    patch.outreach_send_start = null;
    patch.outreach_send_end = null;
  } else {
    const s = parseClockMinutes(startRaw);
    const e = parseClockMinutes(endRaw);
    if (s === null || e === null) return NextResponse.json({ error: "Enter both start and end time as HH:MM." }, { status: 400 });
    // An end time earlier than the start runs past midnight (e.g. 10:00 to 02:00). Equal times are not a window.
    if (e === s) return NextResponse.json({ error: "Start and end time cannot be the same." }, { status: 400 });
    const length = e > s ? e - s : e + 24 * 60 - s;
    if (length < 5) return NextResponse.json({ error: "The window must be at least 5 minutes long." }, { status: 400 });
    patch.outreach_send_start = startRaw;
    patch.outreach_send_end = endRaw;
  }

  if (typeof body.timezone === "string") {
    const tz = body.timezone.trim();
    if (!isValidTimeZone(tz)) return NextResponse.json({ error: "Choose a valid timezone, e.g. Asia/Dubai or America/New_York." }, { status: 400 });
    patch.timezone = tz;
  }
  // The window is always read in the client's own timezone, so a window cannot be saved without one.
  if (!("timezone" in patch)) {
    const { data: current } = await createAdminClient().from("clients").select("timezone").eq("id", client.id).maybeSingle<{ timezone: string | null }>();
    if (!isValidTimeZone(current?.timezone)) {
      return NextResponse.json({ error: "Set your timezone first. Sending runs in your local time." }, { status: 400 });
    }
  }

  const admin = createAdminClient();
  const { error } = await admin.from("clients").update(patch).eq("id", client.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
