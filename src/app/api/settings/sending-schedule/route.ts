import { NextRequest, NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseClockMinutes } from "@/lib/send-window";
import { isValidTimeZone } from "@/lib/social-schedule";

/** GET: return current sending schedule settings for the client. */
export async function GET() {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const admin = createAdminClient();

  const [{ data: clientRow }, { data: job }] = await Promise.all([
    admin
      .from("clients")
      .select("timezone, outreach_send_start, outreach_send_end")
      .eq("id", client.id)
      .maybeSingle<{ timezone: string | null; outreach_send_start: string | null; outreach_send_end: string | null }>(),
    admin
      .from("lead_gen_jobs")
      .select("id, criteria")
      .eq("client_id", client.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; criteria: Record<string, unknown> }>(),
  ]);

  return NextResponse.json({
    ok: true,
    timezone: clientRow?.timezone ?? "",
    sendStart: clientRow?.outreach_send_start ?? "08:00",
    sendEnd: clientRow?.outreach_send_end ?? "20:00",
    followUpDays: job?.criteria?.follow_up_delay_days ?? 3,
    jobId: job?.id ?? null,
  });
}

/** POST: save sending schedule settings. */
export async function POST(req: NextRequest) {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  const admin = createAdminClient();
  const errors: string[] = [];

  // --- Timezone ---
  const timezone = typeof body.timezone === "string" ? body.timezone.trim() : null;
  if (timezone && !isValidTimeZone(timezone)) {
    errors.push("Invalid timezone — use an IANA timezone name (e.g. America/New_York).");
  }

  // --- Send window ---
  const sendStart = typeof body.sendStart === "string" ? body.sendStart.trim() : null;
  const sendEnd = typeof body.sendEnd === "string" ? body.sendEnd.trim() : null;
  if (sendStart && parseClockMinutes(sendStart) === null) errors.push("Invalid send start time — use HH:MM format.");
  if (sendEnd && parseClockMinutes(sendEnd) === null) errors.push("Invalid send end time — use HH:MM format.");
  if (sendStart && sendEnd) {
    const s = parseClockMinutes(sendStart)!;
    const e = parseClockMinutes(sendEnd)!;
    const len = e > s ? e - s : e + 1440 - s;
    if (len < 60) errors.push("Send window must be at least 1 hour long.");
  }

  // --- Follow-up delay ---
  const followUpDays = body.followUpDays !== undefined ? Number(body.followUpDays) : null;
  if (followUpDays !== null && (!Number.isFinite(followUpDays) || followUpDays < 1 || followUpDays > 30)) {
    errors.push("Follow-up delay must be between 1 and 30 days.");
  }

  if (errors.length) return NextResponse.json({ error: errors.join(" ") }, { status: 400 });

  // Update clients table
  const clientFields: Record<string, unknown> = {};
  if (timezone !== null) clientFields.timezone = timezone || null;
  if (sendStart !== null) clientFields.outreach_send_start = sendStart;
  if (sendEnd !== null) clientFields.outreach_send_end = sendEnd;

  if (Object.keys(clientFields).length > 0) {
    const { error } = await admin.from("clients").update(clientFields).eq("id", client.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Update follow_up_delay_days in the most recent lead_gen_job's criteria
  if (followUpDays !== null) {
    const { data: job } = await admin
      .from("lead_gen_jobs")
      .select("id, criteria")
      .eq("client_id", client.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string; criteria: Record<string, unknown> }>();

    if (job) {
      const newCriteria = { ...(job.criteria ?? {}), follow_up_delay_days: followUpDays };
      await admin.from("lead_gen_jobs").update({ criteria: newCriteria }).eq("id", job.id);
    }
  }

  return NextResponse.json({ ok: true });
}
