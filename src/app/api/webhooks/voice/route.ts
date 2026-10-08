import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveClientByCalledNumber } from "@/lib/voice/provision";
import { logEvent } from "@/lib/log-event";

/**
 * Call lifecycle + transcript webhook.
 *
 * The voice agent READS data through /api/voice/facts while somebody is on the
 * phone; this endpoint is the other half — it records that the call happened,
 * for how long, and what the agent said. Without it `client_calls` was only
 * ever written by the outbound cron, so an inbound call left no trace at all:
 * the client could ring their number all day and the Phone page would still say
 * "No calls yet".
 *
 * Called by Twilio/ElevenLabs (via n8n), not a browser, so it authenticates
 * with a shared secret rather than a session. It accepts the field names those
 * providers actually use (`CallSid`/`call_sid`, `CallStatus`/`status`, …) so the
 * workflow author does not have to reshape the payload first.
 *
 * Tenant resolution is the same rule as everywhere else in voice: the number
 * that was DIALED decides whose row this is. A caller can never make us write
 * into another tenant's history.
 */

const SHARED_SECRET = process.env.VOICE_FACTS_SECRET ?? process.env.N8N_WEBHOOK_SECRET;

const MISSING_TABLE_HINT =
  "Call recording is not available yet — run supabase/add_voice_agent.sql in the Supabase SQL editor to add the call columns.";

/**
 * Constant-time secret comparison. A plain `===` leaks timing information
 * proportional to how many leading bytes match, which is enough signal for
 * an attacker to brute-force the secret byte-by-byte over many requests.
 * `crypto.timingSafeEqual` requires equal-length buffers, so length is
 * checked first (a length mismatch is not itself secret — the secret's
 * length is fixed and not attacker-discoverable from this check alone).
 */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const str = (v: unknown): string | null => {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
};

export async function POST(req: NextRequest) {
  if (!SHARED_SECRET) {
    return NextResponse.json({ error: "Voice webhook is not configured" }, { status: 503 });
  }
  const presented = req.headers.get("x-voice-secret") ?? req.headers.get("x-webhook-secret");
  if (!presented || !timingSafeEqualStrings(presented, SHARED_SECRET)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Twilio posts form-encoded; n8n and ElevenLabs post JSON. Accept both.
  const contentType = req.headers.get("content-type") ?? "";
  let body: Record<string, unknown> = {};
  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(await req.text()));
    } else {
      body = (await req.json()) as Record<string, unknown>;
    }
  } catch {
    return NextResponse.json({ error: "Malformed body" }, { status: 400 });
  }
  const data = (body.data ?? body) as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => str(data[k])).find(Boolean) ?? null;

  const callSid = pick("CallSid", "call_sid", "callSid", "conversation_id", "conversationId");
  if (!callSid) return NextResponse.json({ error: "call_sid is required" }, { status: 400 });

  const to = pick("To", "to", "to_number", "called_number");
  const from = pick("From", "from", "from_number", "caller_number");
  const status = pick("CallStatus", "call_status", "status");
  const durationRaw = pick("CallDuration", "call_duration", "duration_seconds", "duration");
  const recordingUrl = pick("RecordingUrl", "recording_url");
  const transcript = pick("Transcript", "transcript", "text");
  const summary = pick("Summary", "summary");
  const elevenConvId = pick("elevenlabs_conversation_id", "conversation_id");

  const admin = createAdminClient();

  // The DIALED number decides the tenant. For an outbound call that is `from`;
  // for an inbound call it is `to`. Try the dialled side first, then the other,
  // and if neither resolves, do not write a row at all rather than guess.
  let clientId: string | null = null;
  for (const candidate of [to, from]) {
    if (!candidate) continue;
    clientId = await resolveClientByCalledNumber(admin, candidate);
    if (clientId) break;
  }
  if (!clientId) {
    logEvent("voice.call_webhook", { result: "unmatched_number", to: to ?? "", from: from ?? "" });
    return NextResponse.json({ ok: true, matched: false });
  }

  const duration = durationRaw !== null && Number.isFinite(Number(durationRaw)) ? Math.round(Number(durationRaw)) : null;
  const patch: Record<string, unknown> = {
    to_number: to,
    from_number: from,
    ...(status ? { status } : {}),
    ...(duration !== null ? { duration_seconds: duration } : {}),
    ...(recordingUrl ? { recording_url: recordingUrl } : {}),
    ...(transcript ? { transcript } : {}),
    ...(summary ? { summary } : {}),
    ...(elevenConvId ? { elevenlabs_conversation_id: elevenConvId } : {}),
    ...(status && /completed|failed|no-answer|busy|canceled/i.test(status) ? { ended_at: new Date().toISOString() } : {}),
  };

  // One row per call SID: the outbound cron may already have created it as
  // "queued", and provider events arrive more than once (started, ringing,
  // completed), so this must update rather than insert duplicates.
  const { data: existing, error: findErr } = await admin
    .from("client_calls")
    .select("id, client_id")
    .eq("call_sid", callSid)
    .maybeSingle<{ id: string; client_id: string }>();

  if (findErr && /does not exist|schema cache|column/i.test(findErr.message)) {
    return NextResponse.json({ error: MISSING_TABLE_HINT }, { status: 503 });
  }

  if (existing) {
    // Never let a webhook move a call to a different tenant.
    if (existing.client_id !== clientId) {
      logEvent("voice.call_webhook", { result: "tenant_mismatch", call_sid: callSid });
      return NextResponse.json({ ok: true, matched: false });
    }
    const { error } = await admin.from("client_calls").update(patch).eq("id", existing.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await admin.from("client_calls").insert({
      client_id: clientId,
      call_sid: callSid,
      // An inbound call is one where the DIALED number is ours.
      direction: to && (await resolveClientByCalledNumber(admin, to)) === clientId ? "inbound" : "outbound",
      status: status ?? "in-progress",
      started_at: new Date().toISOString(),
      created_by: "agent",
      ...patch,
    });
    if (error) {
      const hint = /does not exist|schema cache|column/i.test(error.message) ? MISSING_TABLE_HINT : error.message;
      return NextResponse.json({ error: hint }, { status: 500 });
    }
  }

  logEvent("voice.call_webhook", { client_id: clientId, call_sid: callSid, status: status ?? "unknown", result: "recorded" });
  return NextResponse.json({ ok: true, matched: true, client_id: clientId });
}
