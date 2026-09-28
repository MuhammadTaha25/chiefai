import { NextRequest, NextResponse } from "next/server";
import { verifyMailgunSignature } from "@/lib/webhook-security";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Mailgun's own tracking-event webhook (complaint/unsubscribe — spec PHASE
 * 4/5), distinct from /api/webhooks/mailgun which handles actual reply
 * *content*. Registered per-domain via src/lib/mailgun.ts's
 * registerTrackingWebhooks, pointed at PUBLIC_APP_URL.
 *
 * Payload is Mailgun's v3 JSON webhook format:
 *   { signature: { timestamp, token, signature }, "event-data": { event, id, recipient, ... } }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.signature || !body?.["event-data"]) {
    return NextResponse.json({ error: "Malformed Mailgun event payload" }, { status: 400 });
  }

  const { timestamp, token, signature } = body.signature;
  if (!verifyMailgunSignature(String(timestamp ?? ""), String(token ?? ""), String(signature ?? ""))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const eventData = body["event-data"];
  const eventType = String(eventData.event ?? "");
  const eventId = String(eventData.id ?? "");
  const recipient = String(eventData.recipient ?? "").trim().toLowerCase();

  // A hard bounce arrives as event "failed" with severity "permanent"; soft failures are retried by Mailgun.
  const isBounce = eventType === "failed" && String(eventData.severity ?? "") === "permanent";
  if (!eventId || !recipient || !(["complained", "unsubscribed"].includes(eventType) || isBounce)) {
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  const admin = createAdminClient();

  // Idempotency: the same event delivered twice (Mailgun redelivery, retry)
  // must be a no-op the second time — never a duplicate suppression record
  // or a duplicate side effect.
  const { error: dedupError } = await admin
    .from("processed_provider_events")
    .insert({ id: `mailgun:${eventId}`, provider: "mailgun", event_type: eventType });

  if (dedupError) {
    // Unique violation (23505) means this exact event was already processed.
    if (dedupError.code === "23505") {
      return NextResponse.json({ ok: true, deduped: true });
    }
    return NextResponse.json({ error: dedupError.message }, { status: 500 });
  }

  // Resolve the lead through the message WE sent (outreach_log.provider_message_id), so the same address
  // held by two different clients only suppresses the client whose email actually produced this event.
  const rawMessageId = String(eventData.message?.headers?.["message-id"] ?? "").replace(/^<|>$/g, "");
  let lead: { id: string; client_id: string } | null = null;
  if (rawMessageId) {
    const { data: sentRow } = await admin
      .from("outreach_log")
      .select("lead_id, client_id")
      .in("provider_message_id", [rawMessageId, `<${rawMessageId}>`])
      .limit(1)
      .maybeSingle<{ lead_id: string; client_id: string }>();
    if (sentRow?.lead_id) lead = { id: sentRow.lead_id, client_id: sentRow.client_id };
  }
  if (!lead) {
    const { data: byEmail } = await admin
      .from("leads")
      .select("id, client_id")
      .eq("email", recipient)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    lead = byEmail;
  }

  if (!lead) {
    return NextResponse.json({ ok: true, matched_lead: false });
  }

  if (isBounce) {
    await admin.from("leads").update({ email_bounced: true, next_follow_up_at: null }).eq("id", lead.id).eq("client_id", lead.client_id);
  } else if (eventType === "complained") {
    await admin
      .from("leads")
      .update({ complained: true, complained_at: new Date().toISOString(), next_follow_up_at: null })
      .eq("id", lead.id);
  } else {
    await admin
      .from("leads")
      .update({ unsubscribed: true, unsubscribed_at: new Date().toISOString(), next_follow_up_at: null })
      .eq("id", lead.id);
  }

  return NextResponse.json({ ok: true, event: isBounce ? "bounced" : eventType, leadId: lead.id });
}
