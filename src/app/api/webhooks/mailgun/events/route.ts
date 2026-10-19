import { NextRequest, NextResponse } from "next/server";
import { verifyMailgunSignature } from "@/lib/webhook-security";
import { createAdminClient } from "@/lib/supabase/admin";
import { logEvent } from "@/lib/log-event";
import { buildBounceDetail } from "@/lib/bounce-detail";

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

  // Hard bounce = "failed" + severity "permanent" (invalid address).
  // Soft bounce = "failed" + severity "temporary" (server/mailbox error — Mailgun retries for 8 h then gives up).
  // We capture both so the UI can distinguish them and we can auto-retry soft bounces.
  const severity = String(eventData.severity ?? "");
  const isBounce = eventType === "failed" && (severity === "permanent" || severity === "temporary");
  const bounceType: "permanent" | "temporary" | null =
    isBounce ? (severity === "permanent" ? "permanent" : "temporary") : null;

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
  // No fallback match-by-email-across-all-clients here: the same address can belong to two different
  // clients' lead lists, and guessing would suppress/bounce-flag the WRONG client's lead based on an
  // event that was actually about someone else's email entirely. Only the message-id match above (tied
  // to an email THIS client's mailbox actually sent) is trusted to resolve the client.
  if (!lead) {
    logEvent("mailgun.event_unmatched", { event: eventType, event_id: eventId, recipient });
    return NextResponse.json({ ok: true, matched_lead: false });
  }

  if (isBounce) {
    // Temporary bounce: schedule a retry in 24 hours; do NOT clear next_follow_up_at permanently.
    // Permanent bounce: mark email dead, clear follow-up forever.
    const retryAfter =
      bounceType === "temporary"
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        : null;
    await admin
      .from("leads")
      .update({
        email_bounced: bounceType === "permanent",
        bounce_type: bounceType,
        bounce_retry_after: retryAfter,
        next_follow_up_at: bounceType === "permanent" ? null : undefined,
      })
      .eq("id", lead.id)
      .eq("client_id", lead.client_id);
    // Record-only: keep the receiver's own failure message. A separate best-effort update, so a missing column
    // or any error here can never stop the bounce flag above from being saved.
    try {
      await admin
        .from("leads")
        .update({ bounce_detail: buildBounceDetail(eventData) })
        .eq("id", lead.id)
        .eq("client_id", lead.client_id);
    } catch {
      /* ignore */
    }
  } else if (eventType === "complained") {
    await admin
      .from("leads")
      .update({ complained: true, complained_at: new Date().toISOString(), next_follow_up_at: null })
      .eq("id", lead.id)
      .eq("client_id", lead.client_id);
  } else {
    await admin
      .from("leads")
      .update({ unsubscribed: true, unsubscribed_at: new Date().toISOString(), next_follow_up_at: null })
      .eq("id", lead.id)
      .eq("client_id", lead.client_id);
  }

  return NextResponse.json({
    ok: true,
    event: isBounce ? "bounced" : eventType,
    bounceType: bounceType ?? undefined,
    leadId: lead.id,
  });
}
