import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseClockMinutes } from "@/lib/send-window";
import { isValidTimeZone } from "@/lib/social-schedule";

type Params = { params: Promise<{ campaignId: string }> };

/** GET — return this campaign's window overrides (or nulls if using client defaults) */
export async function GET(_req: NextRequest, { params }: Params) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { campaignId } = await params;
  const admin = createAdminClient();

  const { data: campaign } = await admin
    .from("campaigns")
    .select("send_window_start, send_window_end, timezone, client_id")
    .eq("id", campaignId)
    .eq("client_id", client.id)
    .maybeSingle<{ send_window_start: string | null; send_window_end: string | null; timezone: string | null; client_id: string }>();

  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  // Also return client-level defaults so the UI can show them as placeholder
  const { data: clientRow } = await admin
    .from("clients")
    .select("outreach_send_start, outreach_send_end, timezone")
    .eq("id", client.id)
    .maybeSingle<{ outreach_send_start: string | null; outreach_send_end: string | null; timezone: string | null }>();

  return NextResponse.json({
    ok: true,
    start: campaign.send_window_start?.slice(0, 5) ?? null,
    end: campaign.send_window_end?.slice(0, 5) ?? null,
    timezone: campaign.timezone ?? null,
    clientDefault: {
      start: clientRow?.outreach_send_start?.slice(0, 5) ?? "08:00",
      end: clientRow?.outreach_send_end?.slice(0, 5) ?? "24:00",
      timezone: clientRow?.timezone ?? null,
    },
  });
}

/** POST — save overrides for this campaign */
export async function POST(req: NextRequest, { params }: Params) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { campaignId } = await params;
  const admin = createAdminClient();

  // Verify this campaign belongs to this client
  const { data: campaign } = await admin
    .from("campaigns")
    .select("id")
    .eq("id", campaignId)
    .eq("client_id", client.id)
    .maybeSingle<{ id: string }>();

  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  const startRaw = typeof body.start === "string" ? body.start.trim() : "";
  const endRaw = typeof body.end === "string" ? body.end.trim() : "";

  if (!startRaw && !endRaw) {
    patch.send_window_start = null;
    patch.send_window_end = null;
  } else {
    const s = parseClockMinutes(startRaw);
    const e = parseClockMinutes(endRaw);
    if (s === null || e === null) return NextResponse.json({ error: "Enter both start and end as HH:MM." }, { status: 400 });
    if (e === s) return NextResponse.json({ error: "Start and end cannot be the same." }, { status: 400 });
    const length = e > s ? e - s : e + 24 * 60 - s;
    if (length < 5) return NextResponse.json({ error: "Window must be at least 5 minutes." }, { status: 400 });
    patch.send_window_start = startRaw;
    patch.send_window_end = endRaw;
  }

  if (typeof body.timezone === "string") {
    const tz = body.timezone.trim();
    if (tz && !isValidTimeZone(tz)) return NextResponse.json({ error: "Invalid timezone, e.g. Asia/Karachi or America/New_York." }, { status: 400 });
    patch.timezone = tz || null;
  }

  const { error } = await admin.from("campaigns").update(patch).eq("id", campaignId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
