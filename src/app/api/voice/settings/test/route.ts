import { NextResponse } from "next/server";
import { getCurrentClient } from "@/lib/get-current-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCallSettings } from "@/lib/voice/call-settings";
import { selectVoiceProvider, voiceReadiness } from "@/lib/voice/select";
import { logEvent } from "@/lib/log-event";

/**
 * "Call me now": rings the owner's saved mobile immediately with the daily
 * brief, so the setup can be verified without waiting for the scheduled time.
 * Tenant comes from the session only. Rate-limited to one test per minute.
 */
const lastTest = new Map<string, number>();

export async function POST() {
  const { user, client } = await getCurrentClient();
  if (!user || !client) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const r = voiceReadiness();
  const provider = r.ready && r.purchaseEnabled ? selectVoiceProvider() : null;
  if (!provider) return NextResponse.json({ error: "Voice calling is not enabled on this server yet." }, { status: 503 });

  if (Date.now() - (lastTest.get(client.id) ?? 0) < 60_000) {
    return NextResponse.json({ error: "A test call was just placed. Wait a minute before trying again." }, { status: 429 });
  }

  const admin = createAdminClient();
  const [settings, { data: num }] = await Promise.all([
    getCallSettings(admin, client.id),
    admin.from("client_phone_numbers").select("twilio_number").eq("client_id", client.id).eq("status", "active").limit(1).maybeSingle<{ twilio_number: string }>(),
  ]);
  if (!num) return NextResponse.json({ error: "Buy your business number first." }, { status: 400 });
  if (!settings.personal_phone_number) return NextResponse.json({ error: "Save your mobile number first." }, { status: 400 });

  try {
    lastTest.set(client.id, Date.now());
    const { callSid } = await provider.placeCall({
      from: num.twilio_number,
      to: settings.personal_phone_number,
      metadata: { client_id: client.id, reason: "daily_report", slot: "test" },
    });
    await admin.from("client_calls").insert({ client_id: client.id, call_sid: callSid, direction: "outbound", created_at: new Date().toISOString() });
    logEvent("voice.test_call", { client_id: client.id, result: "placed" });
    return NextResponse.json({ ok: true, message: `Calling ${settings.personal_phone_number} now — pick up.` });
  } catch (err) {
    logEvent("voice.test_call", { client_id: client.id, result: "failed", error: (err as Error).message });
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
